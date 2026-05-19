#include <pebble.h>

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_intensity_layer;
static TextLayer *s_estimated_intensity_layer;
static TextLayer *s_time_layer;
static TextLayer *s_current_location_layer;
static TextLayer *s_station_location_layer;
static TextLayer *s_status_layer;

static int s_last_vibe_time = 0;

#if defined(PBL_COLOR)
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

static GColor prv_text_for_level(int level) {
  return level >= 4 ? GColorBlack : GColorWhite;
}
#endif

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

static void prv_maybe_vibrate(bool should_vibrate) {
  time_t now = time(NULL);

  if (should_vibrate && now - s_last_vibe_time >= 10) {
    vibes_double_pulse();
    s_last_vibe_time = now;
  }
}

static void prv_update_layer_from_tuple(TextLayer *layer, Tuple *tuple) {
  if (tuple) {
    text_layer_set_text(layer, tuple->value->cstring);
  }
}

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

static void prv_inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message dropped: %d", reason);
}

static void prv_outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message send failed: %d", reason);
}

static TextLayer *prv_create_text_layer(GRect frame, GFont font, GTextAlignment alignment) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorBlack);
  text_layer_set_text_color(layer, GColorWhite);
  text_layer_set_font(layer, font);
  text_layer_set_text_alignment(layer, alignment);
  return layer;
}

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

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_estimated_intensity_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_current_location_layer);
  text_layer_destroy(s_station_location_layer);
  text_layer_destroy(s_status_layer);
}

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

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
