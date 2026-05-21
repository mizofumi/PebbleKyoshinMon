/*
 * KyoshinMon - PebbleKit JS(スマホ側 JavaScript)の処理
 *
 * このファイルがすること:
 *   1. スマホの位置情報を取得する
 *   2. 現在地に近い強震モニタ情報を HTTP GET で API から取得する
 *   3. API の JSON を Pebble の画面表示用データに変換する
 *   4. Pebble AppMessage で時計側(Cアプリ)へ送る
 *   5. 設定画面、通知、デモ表示を担当する
 *
 * 通信ルート:
 *
 *   [GPS / phone]
 *        |
 *        | navigator.geolocation
 *        v
 *   [PebbleKit JS] -- XMLHttpRequest(GET) --> [nearest API]
 *        |
 *        | Pebble.sendAppMessage(Dictionary)
 *        v
 *   [Pebble watch C app]
 *
 * 注意:
 *   - Pebble の時計本体は直接インターネットへアクセスしません。
 *     この JavaScript はペアリングされたスマホ側で動き、通信係になります。
 *   - AppMessage で送るキー名(Status など)は package.json の messageKeys と
 *     C 側の MESSAGE_KEY_... と対応しています。
 *   - PebbleKit JS は古い JavaScript 実行環境でも動く必要があるため、
 *     var と ES5 風の書き方に寄せています。
 */

/* 現在地に一番近い観測点・推定震度を返す API の入口です。 */
var API_BASE = 'https://eew.booyah.dev/nearest';

/*
 * 更新間隔です。
 * watchAppVisible=true  の時: 画面を見ているので 1 秒ごとに更新
 * watchAppVisible=false の時: 背景動作なので 5 秒ごとに抑える
 */
var ACTIVE_UPDATE_INTERVAL_MS = 1000;
var BACKGROUND_UPDATE_INTERVAL_MS = 5000;

/* 初回起動時や保存値が壊れていた時に使う既定設定です。 */
var DEFAULT_SETTINGS = {
  notifyEnabled: true,
  notifyThreshold: 4
};

/* アプリ全体で共有する状態です。タイマーや最新位置などを覚えておきます。 */
var latestPosition = null;
var updateTimer = null;
var requestInFlight = false;
var demoUntil = 0;
var watchAppVisible = true;
var lastNotificationKey = null;
var settings = loadSettings();

/*
 * 時計側(Cアプリ)へ AppMessage を送ります。
 *
 * Pebble.sendAppMessage は Pebble SDK の通信 API です。
 * payload は { Status: 'Updated', IntensityLevel: 4 } のような連想配列で、
 * C 側では DictionaryIterator / Tuple として受け取ります。
 */
function sendMessage(payload) {
  Pebble.sendAppMessage(payload, null, function(error) {
    console.log('AppMessage failed: ' + JSON.stringify(error));
  });
}

/*
 * localStorage から通知設定を読み込みます。
 *
 * 注意:
 *   設定 JSON が壊れていて JSON.parse に失敗することがあります。
 *   try/catch で握って既定値に戻すと、設定画面が壊れにくくなります。
 */
function loadSettings() {
  var stored = {};

  try {
    stored = JSON.parse(localStorage.getItem('kyoshinmonSettings') || '{}');
  } catch (error) {
    stored = {};
  }

  return {
    notifyEnabled: stored.notifyEnabled !== false,
    notifyThreshold: normalizeThreshold(stored.notifyThreshold)
  };
}

/*
 * 設定画面から戻ってきた値を保存します。
 * normalizeThreshold で値の範囲を 1〜4 に丸め、変な値が保存されないようにします。
 */
function saveSettings(nextSettings) {
  settings = {
    notifyEnabled: nextSettings.notifyEnabled !== false,
    notifyThreshold: normalizeThreshold(nextSettings.notifyThreshold)
  };

  localStorage.setItem('kyoshinmonSettings', JSON.stringify(settings));
}

/* 通知しきい値を安全な整数に変換します。想定外の値なら既定値へ戻します。 */
function normalizeThreshold(value) {
  var threshold = parseInt(value, 10);

  if (threshold < 1 || threshold > 4 || isNaN(threshold)) {
    return DEFAULT_SETTINGS.notifyThreshold;
  }

  return threshold;
}

/* API の日時文字列を Pebble の狭い画面に収まる表示へ短くします。 */
function formatDataTime(dataTime) {
  if (!dataTime || dataTime.length < 19) {
    return 'Time unknown';
  }

  return dataTime.substring(5, 10).replace('-', '/') + ' ' + dataTime.substring(11, 19);
}

/*
 * 緯度経度を表示用文字列にします。
 * prefix は C(current=現在地) や S(station=観測点) のような短いラベルです。
 */
function formatLocation(prefix, latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return prefix + ' --';
  }

  return prefix + ' ' + latitude.toFixed(4) + ',' + longitude.toFixed(4);
}

/* 推定震度(数値)を "EI 4.0" のような画面表示用文字列にします。 */
function formatEstimatedIntensity(value) {
  if (value === null || typeof value !== 'number' || isNaN(value)) {
    return 'EI no data';
  }

  return 'EI ' + value.toFixed(1);
}

/*
 * API の推定震度を、気象庁震度階級っぽい表示ラベルと色分け用レベルへ変換します。
 *
 * 返す値:
 *   label: 画面に出す文字。例: "5+", "6-"
 *   level: C 側で色分けに使う整数。例: 5, 6
 */
function intensityFromEstimated(value) {
  if (value === null || typeof value !== 'number' || isNaN(value)) {
    return { label: 'NO', level: 0 };
  }

  if (value >= 6.5) {
    return { label: '7', level: 7 };
  }
  if (value >= 6.0) {
    return { label: '6+', level: 6 };
  }
  if (value >= 5.5) {
    return { label: '6-', level: 6 };
  }
  if (value >= 5.0) {
    return { label: '5+', level: 5 };
  }
  if (value >= 4.5) {
    return { label: '5-', level: 5 };
  }
  if (value >= 3.5) {
    return { label: '4', level: 4 };
  }
  if (value >= 2.5) {
    return { label: '3', level: 3 };
  }
  if (value >= 1.5) {
    return { label: '2', level: 2 };
  }
  if (value >= 0.5) {
    return { label: '1', level: 1 };
  }

  return { label: '0', level: 0 };
}

/* ユーザー設定を見て、この震度で通知・振動するかを決めます。 */
function shouldNotify(level) {
  return settings.notifyEnabled && level >= settings.notifyThreshold;
}

/* 通知だけで終わらせず、可能なら時計アプリも前面に起動します。 */
function maybeLaunchWatchApp() {
  if (typeof Pebble.launchApp === 'function') {
    Pebble.launchApp();
  }
}

/*
 * 条件を満たした時だけ Pebble 通知を表示します。
 *
 * 何をするのか:
 *   - 時計アプリ表示中なら、画面更新で分かるので通知は出さない
 *   - しきい値未満なら通知しない
 *   - 同じ dataTime + intensity.label の通知は重複させない
 */
function notifyIfNeeded(response, intensity, estimatedIntensity) {
  if (watchAppVisible || !shouldNotify(intensity.level)) {
    return;
  }

  var notificationKey = response.dataTime + ':' + intensity.label;
  if (notificationKey === lastNotificationKey) {
    return;
  }

  lastNotificationKey = notificationKey;

  Pebble.showSimpleNotificationOnPebble(
    'KyoshinMon ' + intensity.label,
    formatDataTime(response.dataTime) + ' ' + formatEstimatedIntensity(estimatedIntensity)
  );
  maybeLaunchWatchApp();
}

/* デモ表示中は実 API の更新でデモを上書きしないようにします。 */
function isDemoActive() {
  return Date.now() < demoUntil;
}

/*
 * API へ投げる URL を作ります。
 *
 * 通信方法:
 *   GET https://eew.booyah.dev/nearest?lat=<緯度>&lon=<経度>
 *
 * encodeURIComponent を使い、URL に入れて安全な文字列へ変換しています。
 */
function buildUrl(position) {
  var latitude = encodeURIComponent(position.coords.latitude.toFixed(6));
  var longitude = encodeURIComponent(position.coords.longitude.toFixed(6));
  return API_BASE + '?lat=' + latitude + '&lon=' + longitude;
}

/*
 * 現在地に近い地震情報を API から取得し、時計へ送ります。
 *
 * 処理の流れ:
 *
 *   latestPosition なし
 *        -> 時計へ "Getting location..." を表示
 *
 *   latestPosition あり
 *        -> XMLHttpRequest で API へ GET
 *        -> JSON.parse
 *        -> 表示用 payload を作る
 *        -> Pebble.sendAppMessage で時計へ送信
 *
 * 注意:
 *   requestInFlight は「前の通信が終わるまで次を始めない」ための旗です。
 *   これがないと 1 秒更新時に通信が重なり、スマホにも API にも負担がかかります。
 */
function fetchNearest() {
  if (isDemoActive()) {
    return;
  }

  if (!latestPosition) {
    sendMessage({
      Status: 'Getting location...',
      IntensityLabel: '--',
      IntensityLevel: 0
    });
    return;
  }

  if (requestInFlight) {
    return;
  }

  requestInFlight = true;

  var xhr = new XMLHttpRequest();
  xhr.open('GET', buildUrl(latestPosition), true);
  xhr.timeout = 900;
  xhr.onload = function() {
    requestInFlight = false;

    if (xhr.status < 200 || xhr.status >= 300) {
      sendMessage({ Status: 'API error ' + xhr.status });
      return;
    }

    try {
      var response = JSON.parse(xhr.responseText);
      var nearest = response.nearest || {};
      var intensity = intensityFromEstimated(nearest.estimatedIntensity);
      var payload = {
        Status: 'Updated',
        DataTime: formatDataTime(response.dataTime),
        IntensityLabel: intensity.label,
        IntensityLevel: intensity.level,
        EstimatedIntensity: formatEstimatedIntensity(nearest.estimatedIntensity),
        CurrentLocation: formatLocation(
          'C',
          latestPosition.coords.latitude,
          latestPosition.coords.longitude
        ),
        StationLocation: formatLocation('S', nearest.lat, nearest.lon),
        ShouldVibrate: shouldNotify(intensity.level) ? 1 : 0
      };

      notifyIfNeeded(response, intensity, nearest.estimatedIntensity);

      if (watchAppVisible) {
        sendMessage(payload);
      }
    } catch (error) {
      console.log('Parse failed: ' + error.message);
      sendMessage({ Status: 'Parse error' });
    }
  };
  xhr.onerror = function() {
    requestInFlight = false;
    sendMessage({ Status: 'Network error' });
  };
  xhr.ontimeout = function() {
    requestInFlight = false;
    sendMessage({ Status: 'Timeout' });
  };
  xhr.send();
}

/*
 * 設定画面の「デモ」用です。
 * 震度0から7までを順番に時計へ送り、色・文字・バイブの確認をしやすくします。
 */
function sendDemoSequence() {
  var sequence = [
    { label: '0', level: 0, estimatedIntensity: 0.0 },
    { label: '1', level: 1, estimatedIntensity: 1.0 },
    { label: '2', level: 2, estimatedIntensity: 2.0 },
    { label: '3', level: 3, estimatedIntensity: 3.0 },
    { label: '4', level: 4, estimatedIntensity: 4.0 },
    { label: '5-', level: 5, estimatedIntensity: 5.0 },
    { label: '5+', level: 5, estimatedIntensity: 5.5 },
    { label: '6-', level: 6, estimatedIntensity: 6.0 },
    { label: '6+', level: 6, estimatedIntensity: 6.5 },
    { label: '7', level: 7, estimatedIntensity: 7.0 }
  ];

  demoUntil = Date.now() + sequence.length * 900 + 1200;

  for (var index = 0; index < sequence.length; index += 1) {
    (function(step, stepIndex) {
      setTimeout(function() {
        sendMessage({
          Status: 'Demo',
          DataTime: 'Demo ' + (stepIndex + 1) + '/' + sequence.length,
          IntensityLabel: step.label,
          IntensityLevel: step.level,
          EstimatedIntensity: formatEstimatedIntensity(step.estimatedIntensity),
          CurrentLocation: 'C demo',
          StationLocation: 'S demo',
          ShouldVibrate: shouldNotify(step.level) ? 1 : 0
        });
      }, stepIndex * 900);
    })(sequence[index], index);
  }

  setTimeout(fetchNearest, sequence.length * 900 + 1300);
}

/* Pebble の通知機能だけを単体で確認するためのテスト通知です。 */
function sendNotificationTest() {
  Pebble.showSimpleNotificationOnPebble(
    'KyoshinMon Test',
    '通知テスト EI 4.0'
  );
}

/*
 * スマホの位置情報を取得してから API 更新へ進みます。
 *
 * navigator.geolocation はブラウザ互換の位置情報 API です。
 * PebbleKit JS ではスマホ側の位置情報を使います。
 */
function requestPositionAndFetch() {
  navigator.geolocation.getCurrentPosition(updatePosition, handleLocationError, {
    enableHighAccuracy: false,
    maximumAge: watchAppVisible ? 10000 : BACKGROUND_UPDATE_INTERVAL_MS,
    timeout: 10000
  });
}

/*
 * 定期更新タイマーを作り直します。
 *
 * 画面表示中とバックグラウンドで更新間隔を変えるため、
 * show/hide のたびに clearInterval -> setInterval し直します。
 */
function scheduleUpdates() {
  var interval = watchAppVisible ? ACTIVE_UPDATE_INTERVAL_MS : BACKGROUND_UPDATE_INTERVAL_MS;

  if (updateTimer) {
    clearInterval(updateTimer);
  }

  requestPositionAndFetch();
  updateTimer = setInterval(requestPositionAndFetch, interval);
}

/*
 * Pebble の設定画面として開く HTML を data URL で作ります。
 *
 * Pebble.openURL に data:text/html を渡すと、スマホ側に小さな設定 WebView を出せます。
 * WebView を閉じる時は pebblejs://close#<JSON> に遷移し、webviewclosed イベントへ
 * 設定値を返します。
 *
 *   設定画面  -- pebblejs://close#... -->  webviewclosed handler
 */
function configurationUrl() {
  var html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>KyoshinMon</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#101418;color:#f5f7fa;}',
    '.wrap{padding:18px;}',
    'h1{font-size:22px;margin:0 0 18px;}',
    '.row{background:#1b222a;border:1px solid #303a45;border-radius:8px;padding:14px;margin-bottom:12px;}',
    'label{display:block;font-size:14px;color:#c8d0d8;margin-bottom:8px;}',
    'select,button{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #465260;padding:12px;font-size:16px;}',
    'select{background:#0f1419;color:#fff;}',
    'button{background:#f5c542;color:#111;font-weight:700;margin-top:8px;}',
    '.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
    '.switch label{margin:0;font-size:16px;color:#fff;}',
    'input[type=checkbox]{width:28px;height:28px;}',
    '.sub{font-size:13px;color:#a8b3be;line-height:1.45;margin-top:8px;}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<h1>KyoshinMon</h1>',
    '<div class="row switch">',
    '<label for="notifyEnabled">自動通知</label>',
    '<input id="notifyEnabled" type="checkbox">',
    '</div>',
    '<div class="row">',
    '<label for="notifyThreshold">通知する震度の目安</label>',
    '<select id="notifyThreshold">',
    '<option value="1">震度1以上</option>',
    '<option value="2">震度2以上</option>',
    '<option value="3">震度3以上</option>',
    '<option value="4">震度4以上</option>',
    '</select>',
    '<div class="sub">設定した震度以上を感知した時に時計を振動させます。</div>',
    '</div>',
    '<div class="row">',
    '<label>通知テスト</label>',
    '<button id="notificationTestButton" type="button">通知テストを送信</button>',
    '<div class="sub">時計アプリを開いていない状態でもPebble通知が届くか確認できます。</div>',
    '</div>',
    '<div class="row">',
    '<label>デモ</label>',
    '<button id="demoButton" type="button">震度デモを送信</button>',
    '<div class="sub">押すと時計側で0, 1, 2, 3, 4, 5-, 5+, 6-, 6+, 7の順に表示します。</div>',
    '</div>',
    '<button id="saveButton" type="button">保存</button>',
    '</div>',
    '<script>',
    'var settings=' + JSON.stringify(settings) + ';',
    'var enabled=document.getElementById("notifyEnabled");',
    'var threshold=document.getElementById("notifyThreshold");',
    'enabled.checked=settings.notifyEnabled!==false;',
    'threshold.value=String(settings.notifyThreshold||4);',
    'function currentSettings(){return{notifyEnabled:enabled.checked,notifyThreshold:parseInt(threshold.value,10)};}',
    'function closeWith(action){var payload=currentSettings();payload.action=action;document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(payload));}',
    'document.getElementById("saveButton").addEventListener("click",function(){closeWith("save");});',
    'document.getElementById("notificationTestButton").addEventListener("click",function(){closeWith("notificationTest");});',
    'document.getElementById("demoButton").addEventListener("click",function(){closeWith("demo");});',
    '</script>',
    '</body>',
    '</html>'
  ].join('');

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/* 位置情報の取得に成功した時に呼ばれます。最新位置を保存して API 更新へ進みます。 */
function updatePosition(position) {
  latestPosition = position;
  fetchNearest();
}

/* 位置情報が取れなかった時の処理です。時計側へエラー表示を送ります。 */
function handleLocationError(error) {
  console.log('Location error: ' + JSON.stringify(error));

  if (watchAppVisible) {
    sendMessage({
      Status: 'Location error',
      IntensityLabel: '--',
      IntensityLevel: 0
    });
  }
}

/* PebbleKit JS 起動時や表示再開時に、定期更新を開始します。 */
function startUpdates() {
  scheduleUpdates();
}

/* 必要になった時に定期更新を止めるための関数です。現在は予備として置いています。 */
function stopUpdates() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

/*
 * ここから下は PebbleKit JS のイベント登録です。
 *
 * ready             : JS が起動した
 * show              : 時計アプリが表示された
 * hide              : 時計アプリが非表示になった
 * appmessage        : 時計側から何か届いた
 * showConfiguration : ユーザーが設定画面を開いた
 * webviewclosed     : 設定画面が閉じられた
 */
Pebble.addEventListener('ready', function() {
  watchAppVisible = true;
  startUpdates();
});

Pebble.addEventListener('show', function() {
  watchAppVisible = true;
  scheduleUpdates();
});

Pebble.addEventListener('appmessage', function() {
  fetchNearest();
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(configurationUrl());
});

Pebble.addEventListener('webviewclosed', function(event) {
  if (!event || !event.response) {
    return;
  }

  try {
    var response = JSON.parse(decodeURIComponent(event.response));
    saveSettings(response);

    if (response.action === 'demo') {
      sendDemoSequence();
    } else if (response.action === 'notificationTest') {
      sendNotificationTest();
    } else {
      fetchNearest();
    }
  } catch (error) {
    console.log('Configuration parse failed: ' + error.message);
  }
});

Pebble.addEventListener('hide', function() {
  watchAppVisible = false;
  scheduleUpdates();
});
