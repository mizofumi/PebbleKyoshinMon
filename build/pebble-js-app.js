/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

	__webpack_require__(1);
	module.exports = __webpack_require__(2);


/***/ }),
/* 1 */
/***/ (function(module, exports) {

	/**
	 * Copyright 2024 Google LLC
	 *
	 * Licensed under the Apache License, Version 2.0 (the "License");
	 * you may not use this file except in compliance with the License.
	 * You may obtain a copy of the License at
	 *
	 *     http://www.apache.org/licenses/LICENSE-2.0
	 *
	 * Unless required by applicable law or agreed to in writing, software
	 * distributed under the License is distributed on an "AS IS" BASIS,
	 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 * See the License for the specific language governing permissions and
	 * limitations under the License.
	 */
	
	(function(p) {
	  if (!p === undefined) {
	    console.error('Pebble object not found!?');
	    return;
	  }
	
	  // Aliases:
	  p.on = p.addEventListener;
	  p.off = p.removeEventListener;
	
	  // For Android (WebView-based) pkjs, print stacktrace for uncaught errors:
	  if (typeof window !== 'undefined' && window.addEventListener) {
	    window.addEventListener('error', function(event) {
	      if (event.error && event.error.stack) {
	        console.error('' + event.error + '\n' + event.error.stack);
	      }
	    });
	  }
	
	})(Pebble);


/***/ }),
/* 2 */
/***/ (function(module, exports) {

	var API_BASE = 'https://eew.booyah.dev/nearest';
	var UPDATE_INTERVAL_MS = 1000;
	var DEFAULT_SETTINGS = {
	  notifyEnabled: true,
	  notifyThreshold: 4
	};
	
	var latestPosition = null;
	var updateTimer = null;
	var requestInFlight = false;
	var demoUntil = 0;
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
	
	      sendMessage({
	        Status: 'Updated',
	        DataTime: formatDataTime(response.dataTime),
	        IntensityLabel: intensity.label,
	        IntensityLevel: intensity.level,
	        CurrentLocation: formatLocation(
	          'C',
	          latestPosition.coords.latitude,
	          latestPosition.coords.longitude
	        ),
	        StationLocation: formatLocation('S', nearest.lat, nearest.lon),
	        ShouldVibrate: shouldNotify(intensity.level) ? 1 : 0
	      });
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
	    { label: '0', level: 0 },
	    { label: '1', level: 1 },
	    { label: '2', level: 2 },
	    { label: '3', level: 3 },
	    { label: '4', level: 4 },
	    { label: '5-', level: 5 },
	    { label: '5+', level: 5 },
	    { label: '6-', level: 6 },
	    { label: '6+', level: 6 },
	    { label: '7', level: 7 }
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
	          CurrentLocation: 'C demo',
	          StationLocation: 'S demo',
	          ShouldVibrate: shouldNotify(step.level) ? 1 : 0
	        });
	      }, stepIndex * 900);
	    })(sequence[index], index);
	  }
	
	  setTimeout(fetchNearest, sequence.length * 900 + 1300);
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
	  sendMessage({
	    Status: 'Location error',
	    IntensityLabel: '--',
	    IntensityLevel: 0
	  });
	}
	
	function startUpdates() {
	  navigator.geolocation.getCurrentPosition(updatePosition, handleLocationError, {
	    enableHighAccuracy: false,
	    maximumAge: 10000,
	    timeout: 10000
	  });
	
	  updateTimer = setInterval(function() {
	    navigator.geolocation.getCurrentPosition(updatePosition, handleLocationError, {
	      enableHighAccuracy: false,
	      maximumAge: 10000,
	      timeout: 10000
	    });
	  }, UPDATE_INTERVAL_MS);
	}
	
	function stopUpdates() {
	  if (updateTimer) {
	    clearInterval(updateTimer);
	    updateTimer = null;
	  }
	}
	
	Pebble.addEventListener('ready', function() {
	  startUpdates();
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
	    } else {
	      fetchNearest();
	    }
	  } catch (error) {
	    console.log('Configuration parse failed: ' + error.message);
	  }
	});
	
	Pebble.addEventListener('hide', function() {
	  stopUpdates();
	});


/***/ })
/******/ ]);
//# sourceMappingURL=pebble-js-app.js.map