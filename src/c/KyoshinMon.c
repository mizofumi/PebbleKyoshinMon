#include <pebble.h>

/*
 * KyoshinMon - Pebble 側(C言語)の画面表示担当
 *
 * このファイルがすること:
 *   1. Pebble の画面(Window)と文字表示(TextLayer)を作る
 *   2. スマホ側 JavaScript(PebbleKit JS)から届いた地震情報を受け取る
 *   3. 震度に合わせて背景色・文字色・バイブレーションを変える
 *
 * 通信の全体像:
 *
 *   +-------------------+        HTTP GET         +------------------+
 *   | Phone / pkjs JS   | ----------------------> | eew.booyah.dev   |
 *   | src/pkjs/index.js |                         | nearest API      |
 *   +---------+---------+                         +------------------+
 *             |
 *             | Pebble AppMessage
 *             | Dictionary: Status, DataTime, IntensityLabel...
 *             v
 *   +---------+---------+
 *   | Watch / C app     |
 *   | this file         |
 *   +-------------------+
 *
 * 注意:
 *   - Pebble の C 側は直接インターネット通信しません。
 *     通信・位置情報取得はスマホ側の PebbleKit JS が担当します。
 *   - `MESSAGE_KEY_...` は package.json の `messageKeys` から
 *     Pebble SDK が自動生成する定数です。
 *   - TextLayer に渡す文字列は AppMessage のバッファ由来です。
 *     このアプリでは受信直後に表示へ反映する使い方にしています。
 *
 * C 側ライフサイクル:
 *
 *   main()
 *     |
 *     v
 *   prv_init()
 *     |  Window 作成、callback 登録、AppMessage 開始
 *     v
 *   window_stack_push()
 *     |
 *     v
 *   prv_window_load()
 *     |  TextLayer 作成、初期表示
 *     v
 *   app_event_loop()
 *     |  ここで待機し続け、以下のイベントで callback が呼ばれる
 *     |    - AppMessage 受信       -> prv_inbox_received_callback()
 *     |    - AppMessage 受信失敗   -> prv_inbox_dropped_callback()
 *     |    - Window が閉じられる   -> prv_window_unload()
 *     v
 *   prv_deinit()
 *     |  Window 破棄
 *     v
 *   終了
 */

/* 画面部品は callback の中からも触るため、ファイル全体で使える static 変数にします。 */
static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_intensity_layer;
static TextLayer *s_estimated_intensity_layer;
static TextLayer *s_time_layer;
static TextLayer *s_current_location_layer;
static TextLayer *s_station_location_layer;
static TextLayer *s_status_layer;

/* バイブを連続で鳴らしすぎないため、最後に鳴らした時刻を覚えておきます。 */
static int s_last_vibe_time = 0;

#if defined(PBL_COLOR)
/*
 * 震度レベルから背景色を決めます。
 *
 * PBL_COLOR はカラー対応 Pebble でだけ定義されます。
 * 白黒モデルでは色名が使えないため、この関数自体をコンパイルしません。
 */
static GColor prv_background_for_level(int level) {
  switch (level) {
    case 7:
      return GColorBulgarianRose;
    case 6:
      return GColorRed;
    case 5:
      return GColorOrange;
    case 4:
      return GColorYellow;
    case 3:
      return GColorChromeYellow;
    case 2:
      return GColorIslamicGreen;
    case 1:
      return GColorJaegerGreen;
    default:
      return GColorBlack;
  }
}

/*
 * 背景が明るい震度4以上では黒文字、それ以外は白文字にして読みやすくします。
 */
static GColor prv_text_for_level(int level) {
  return level >= 4 ? GColorBlack : GColorWhite;
}
#endif

/*
 * 画面全体の色を一括で更新します。
 *
 * 何をするのか:
 *   - Window の背景色を変える
 *   - すべての TextLayer の背景色を揃える
 *   - すべての TextLayer の文字色を揃える
 *
 * 注意:
 *   TextLayer ごとに背景色を指定しないと、古い色の四角が残って見えることがあります。
 */
static void prv_apply_colors(int level) {
#if defined(PBL_COLOR)
  GColor background = prv_background_for_level(level);
  GColor text = prv_text_for_level(level);
#else
  GColor background = GColorBlack;
  GColor text = GColorWhite;
#endif

  window_set_background_color(s_window, background);
  text_layer_set_background_color(s_title_layer, background);
  text_layer_set_background_color(s_intensity_layer, background);
  text_layer_set_background_color(s_estimated_intensity_layer, background);
  text_layer_set_background_color(s_time_layer, background);
  text_layer_set_background_color(s_current_location_layer, background);
  text_layer_set_background_color(s_station_location_layer, background);
  text_layer_set_background_color(s_status_layer, background);

  text_layer_set_text_color(s_title_layer, text);
  text_layer_set_text_color(s_intensity_layer, text);
  text_layer_set_text_color(s_estimated_intensity_layer, text);
  text_layer_set_text_color(s_time_layer, text);
  text_layer_set_text_color(s_current_location_layer, text);
  text_layer_set_text_color(s_station_location_layer, text);
  text_layer_set_text_color(s_status_layer, text);
}

/*
 * 必要なら時計を振動させます。
 *
 * should_vibrate はスマホ側で「通知設定」と「震度しきい値」を見て決めます。
 * C 側ではさらに 10 秒の間隔制限を入れ、同じ情報で何度も振動しないようにします。
 */
static void prv_maybe_vibrate(bool should_vibrate) {
  time_t now = time(NULL);

  if (should_vibrate && now - s_last_vibe_time >= 10) {
    vibes_double_pulse();
    s_last_vibe_time = now;
  }
}

/*
 * AppMessage の Tuple から文字列を取り出し、TextLayer に表示します。
 *
 * Tuple とは:
 *   Pebble SDK の AppMessage で使う「キーと値」の入れ物です。
 *   JavaScript 側の { Status: 'Updated' } のような値が、
 *   C 側では Tuple として届きます。
 *
 * 注意:
 *   tuple が届いていない可能性があるので、NULL チェックをしてから使います。
 */
static void prv_update_layer_from_tuple(TextLayer *layer, Tuple *tuple) {
  if (tuple) {
    text_layer_set_text(layer, tuple->value->cstring);
  }
}

/*
 * スマホ側から AppMessage を受信した時に Pebble SDK から呼ばれる callback です。
 *
 * 何をするのか:
 *   1. DictionaryIterator から message key ごとの Tuple を探す
 *   2. 届いた文字列をそれぞれの TextLayer に表示する
 *   3. IntensityLevel を元に色を変える
 *   4. ShouldVibrate が true 相当ならバイブを鳴らす
 *
 * AppMessage のイメージ:
 *
 *   JS payload                  C Tuple
 *   ------------------------------------------------
 *   Status: "Updated"       -> MESSAGE_KEY_Status
 *   DataTime: "05/22 ..."   -> MESSAGE_KEY_DataTime
 *   IntensityLevel: 4       -> MESSAGE_KEY_IntensityLevel
 */
static void prv_inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *status_tuple = dict_find(iter, MESSAGE_KEY_Status);
  Tuple *time_tuple = dict_find(iter, MESSAGE_KEY_DataTime);
  Tuple *intensity_tuple = dict_find(iter, MESSAGE_KEY_IntensityLabel);
  Tuple *level_tuple = dict_find(iter, MESSAGE_KEY_IntensityLevel);
  Tuple *estimated_intensity_tuple = dict_find(iter, MESSAGE_KEY_EstimatedIntensity);
  Tuple *current_location_tuple = dict_find(iter, MESSAGE_KEY_CurrentLocation);
  Tuple *station_location_tuple = dict_find(iter, MESSAGE_KEY_StationLocation);
  Tuple *should_vibrate_tuple = dict_find(iter, MESSAGE_KEY_ShouldVibrate);

  prv_update_layer_from_tuple(s_status_layer, status_tuple);
  prv_update_layer_from_tuple(s_time_layer, time_tuple);
  prv_update_layer_from_tuple(s_intensity_layer, intensity_tuple);
  prv_update_layer_from_tuple(s_estimated_intensity_layer, estimated_intensity_tuple);
  prv_update_layer_from_tuple(s_current_location_layer, current_location_tuple);
  prv_update_layer_from_tuple(s_station_location_layer, station_location_tuple);

  if (level_tuple) {
    int level = (int)level_tuple->value->int32;
    bool should_vibrate = should_vibrate_tuple && should_vibrate_tuple->value->int32;
    prv_apply_colors(level);
    prv_maybe_vibrate(should_vibrate);
  }
}

/* 受信バッファが足りない等でメッセージを受け取れなかった時のログです。 */
static void prv_inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message dropped: %d", reason);
}

/* C 側から JS 側へ送る時に失敗した場合の callback です。このアプリでは主にログ用途です。 */
static void prv_outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message send failed: %d", reason);
}

/*
 * TextLayer を作るための小さな共通関数です。
 *
 * 何をするのか:
 *   - 位置とサイズ(frame)を指定して TextLayer を作る
 *   - 背景色・文字色・フォント・文字揃えを設定する
 *
 * 注意:
 *   text_layer_create したものは、不要になったら text_layer_destroy が必要です。
 *   このファイルでは prv_window_unload でまとめて破棄します。
 */
static TextLayer *prv_create_text_layer(GRect frame, GFont font, GTextAlignment alignment) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorBlack);
  text_layer_set_text_color(layer, GColorWhite);
  text_layer_set_font(layer, font);
  text_layer_set_text_alignment(layer, alignment);
  return layer;
}

/*
 * Window が画面に読み込まれる時に呼ばれる callback です。
 *
 * 何をするのか:
 *   - 画面サイズを取得する
 *   - タイトル、震度、推定震度、時刻、位置、状態表示の TextLayer を並べる
 *   - 初期表示の文字を入れる
 *
 * レイヤーのざっくり配置:
 *
 *   +----------------------+
 *   |      KyoshinMon      |
 *   |          --          |
 *   |        EI --         |
 *   |     Waiting time     |
 *   |        C --          |
 *   |        S --          |
 *   |  Getting location... |
 *   +----------------------+
 */
static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_title_layer = prv_create_text_layer(
      GRect(0, 8, bounds.size.w, 20),
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GTextAlignmentCenter);
  text_layer_set_text(s_title_layer, "KyoshinMon");
  layer_add_child(window_layer, text_layer_get_layer(s_title_layer));

  s_intensity_layer = prv_create_text_layer(
      GRect(0, 30, bounds.size.w, 46),
      fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
      GTextAlignmentCenter);
  text_layer_set_text(s_intensity_layer, "--");
  layer_add_child(window_layer, text_layer_get_layer(s_intensity_layer));

  s_estimated_intensity_layer = prv_create_text_layer(
      GRect(0, 74, bounds.size.w, 20),
      fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GTextAlignmentCenter);
  text_layer_set_text(s_estimated_intensity_layer, "EI --");
  layer_add_child(window_layer, text_layer_get_layer(s_estimated_intensity_layer));

  s_time_layer = prv_create_text_layer(
      GRect(0, 98, bounds.size.w, 24),
      fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GTextAlignmentCenter);
  text_layer_set_text(s_time_layer, "Waiting time");
  layer_add_child(window_layer, text_layer_get_layer(s_time_layer));

  s_current_location_layer = prv_create_text_layer(
      GRect(0, 122, bounds.size.w, 18),
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GTextAlignmentCenter);
  text_layer_set_text(s_current_location_layer, "C --");
  layer_add_child(window_layer, text_layer_get_layer(s_current_location_layer));

  s_station_location_layer = prv_create_text_layer(
      GRect(0, 140, bounds.size.w, 18),
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GTextAlignmentCenter);
  text_layer_set_text(s_station_location_layer, "S --");
  layer_add_child(window_layer, text_layer_get_layer(s_station_location_layer));

  s_status_layer = prv_create_text_layer(
      GRect(0, bounds.size.h - 22, bounds.size.w, 20),
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "Getting location...");
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  prv_apply_colors(0);
}

/*
 * Window が閉じられる時に呼ばれる callback です。
 *
 * Pebble SDK では create した UI 部品を destroy してメモリを返す必要があります。
 */
static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_estimated_intensity_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_current_location_layer);
  text_layer_destroy(s_station_location_layer);
  text_layer_destroy(s_status_layer);
}

/*
 * アプリ起動時の初期化です。
 *
 * 何をするのか:
 *   1. Window を作成する
 *   2. Window の load/unload callback を登録する
 *   3. AppMessage の受信・失敗 callback を登録する
 *   4. AppMessage のバッファを開く
 *   5. Window を画面スタックに積んで表示する
 *
 * AppMessage buffer:
 *   app_message_open(受信バイト数, 送信バイト数)
 *   このアプリは JS -> C の受信が中心なので、受信側を 256 bytes にしています。
 */
static void prv_init(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });

  app_message_register_inbox_received(prv_inbox_received_callback);
  app_message_register_inbox_dropped(prv_inbox_dropped_callback);
  app_message_register_outbox_failed(prv_outbox_failed_callback);
  app_message_open(256, 64);

  const bool animated = true;
  window_stack_push(s_window, animated);
}

/* アプリ終了時の後片付けです。Window は create したので destroy します。 */
static void prv_deinit(void) {
  window_destroy(s_window);
}

/*
 * C プログラムの入口です。
 *
 * Pebble アプリでは:
 *   - prv_init() で準備
 *   - app_event_loop() でイベント待ち
 *   - prv_deinit() で終了処理
 *
 * app_event_loop() の間、ボタン操作・AppMessage 受信・画面表示などのイベントを
 * Pebble OS が callback として呼び出してくれます。
 *
 * 初心者向けの見方:
 *   main 自体はとても短いですが、実際の処理は登録済み callback に分かれています。
 *   「起動時に全部を順番に実行する」のではなく、
 *   「起動時に準備して、あとはイベントが来た時だけ反応する」構造です。
 */
int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
