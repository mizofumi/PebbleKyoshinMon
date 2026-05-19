var API_BASE = 'https://eew.booyah.dev/nearest';
var UPDATE_INTERVAL_MS = 1000;

var latestPosition = null;
var updateTimer = null;
var requestInFlight = false;

function sendMessage(payload) {
  Pebble.sendAppMessage(payload, null, function(error) {
    console.log('AppMessage failed: ' + JSON.stringify(error));
  });
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

function buildUrl(position) {
  var latitude = encodeURIComponent(position.coords.latitude.toFixed(6));
  var longitude = encodeURIComponent(position.coords.longitude.toFixed(6));
  return API_BASE + '?lat=' + latitude + '&lon=' + longitude;
}

function fetchNearest() {
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
        StationLocation: formatLocation('S', nearest.lat, nearest.lon)
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

Pebble.addEventListener('showConfiguration', function() {});
Pebble.addEventListener('webviewclosed', function() {});

Pebble.addEventListener('hide', function() {
  stopUpdates();
});
