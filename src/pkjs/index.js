var API_BASE = 'https://eew.booyah.dev/nearest';
var ACTIVE_UPDATE_INTERVAL_MS = 1000;
var BACKGROUND_UPDATE_INTERVAL_MS = 5000;
var DEFAULT_SETTINGS = {
  notifyEnabled: true,
  notifyThreshold: 4
};

var latestPosition = null;
var updateTimer = null;
var requestInFlight = false;
var demoUntil = 0;
var watchAppVisible = true;
var lastNotificationKey = null;
var settings = loadSettings();

function sendMessage(payload) {
  Pebble.sendAppMessage(payload, null, function(error) {
    console.log('AppMessage failed: ' + JSON.stringify(error));
  });
}

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

function saveSettings(nextSettings) {
  settings = {
    notifyEnabled: nextSettings.notifyEnabled !== false,
    notifyThreshold: normalizeThreshold(nextSettings.notifyThreshold)
  };

  localStorage.setItem('kyoshinmonSettings', JSON.stringify(settings));
}

function normalizeThreshold(value) {
  var threshold = parseInt(value, 10);

  if (threshold < 1 || threshold > 4 || isNaN(threshold)) {
    return DEFAULT_SETTINGS.notifyThreshold;
  }

  return threshold;
}

function formatDataTime(dataTime) {
  if (!dataTime || dataTime.length < 19) {
    return 'Time unknown';
  }

  return dataTime.substring(5, 10).replace('-', '/') + ' ' + dataTime.substring(11, 19);
}

function formatLocation(prefix, latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return prefix + ' --';
  }

  return prefix + ' ' + latitude.toFixed(4) + ',' + longitude.toFixed(4);
}

function formatEstimatedIntensity(value) {
  if (value === null || typeof value !== 'number' || isNaN(value)) {
    return 'EI no data';
  }

  return 'EI ' + value.toFixed(1);
}

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

function shouldNotify(level) {
  return settings.notifyEnabled && level >= settings.notifyThreshold;
}

function maybeLaunchWatchApp() {
  if (typeof Pebble.launchApp === 'function') {
    Pebble.launchApp();
  }
}

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

function isDemoActive() {
  return Date.now() < demoUntil;
}

function buildUrl(position) {
  var latitude = encodeURIComponent(position.coords.latitude.toFixed(6));
  var longitude = encodeURIComponent(position.coords.longitude.toFixed(6));
  return API_BASE + '?lat=' + latitude + '&lon=' + longitude;
}

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

function sendNotificationTest() {
  Pebble.showSimpleNotificationOnPebble(
    'KyoshinMon Test',
    '通知テスト EI 4.0'
  );
}

function requestPositionAndFetch() {
  navigator.geolocation.getCurrentPosition(updatePosition, handleLocationError, {
    enableHighAccuracy: false,
    maximumAge: watchAppVisible ? 10000 : BACKGROUND_UPDATE_INTERVAL_MS,
    timeout: 10000
  });
}

function scheduleUpdates() {
  var interval = watchAppVisible ? ACTIVE_UPDATE_INTERVAL_MS : BACKGROUND_UPDATE_INTERVAL_MS;

  if (updateTimer) {
    clearInterval(updateTimer);
  }

  requestPositionAndFetch();
  updateTimer = setInterval(requestPositionAndFetch, interval);
}

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

function updatePosition(position) {
  latestPosition = position;
  fetchNearest();
}

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

function startUpdates() {
  scheduleUpdates();
}

function stopUpdates() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

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
