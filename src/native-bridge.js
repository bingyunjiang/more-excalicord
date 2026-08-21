(function (global) {
  "use strict";

  var BASE_URL = "http://127.0.0.1:5002/v1";
  var lastHealth = null;
  var lastHealthAt = 0;
  var sessionToken = "";

  function request(path, options, timeoutMs, retriedAfterAuth) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs || 1800);
    var init = Object.assign({}, options || {});
    init.headers = Object.assign({}, init.headers || {});
    if (sessionToken && path !== "/health") {
      init.headers["X-Excalicord-Token"] = sessionToken;
    }
    init.signal = controller.signal;
    init.cache = "no-store";
    return fetch(BASE_URL + path, init)
      .then(function (response) {
        if (response.status === 403 && path !== "/health" && !retriedAfterAuth) {
          return health(true).then(function () {
            return request(path, options, timeoutMs, true);
          });
        }
        if (!response.ok) {
          return response.json().catch(function () {
            return { message: "本地录制服务返回 " + response.status };
          }).then(function (body) {
            throw new Error(body.message || "本地录制服务请求失败");
          });
        }
        return response;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function jsonRequest(path, method, body, timeoutMs) {
    return request(
      path,
      {
        method: method || "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    ).then(function (response) {
      return response.json();
    });
  }

  function blobRequest(path, blob, fileName, timeoutMs) {
    return request(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": (blob && blob.type) || "application/octet-stream",
          "X-Excalicord-File-Name": fileName || "excalicord.mp4",
        },
        body: blob,
      },
      timeoutMs || 120000,
    ).then(function (response) {
      return response.json();
    });
  }

  function health(force) {
    var now = Date.now();
    if (!force && lastHealth && now - lastHealthAt < 1500) {
      return Promise.resolve(lastHealth);
    }
    return jsonRequest("/health", "GET", null, 1000).then(function (value) {
      lastHealth = value;
      lastHealthAt = Date.now();
      sessionToken = value.token || "";
      return value;
    });
  }

  function downloadLastRecording() {
    return request("/recording", { method: "GET" }, 30000)
      .then(function (response) {
        var disposition = response.headers.get("Content-Disposition") || "";
        var match = disposition.match(/filename="([^"]+)"/);
        return response.blob().then(function (blob) {
          return {
            blob: blob,
            fileName: match ? match[1] : "excalicord-desktop.mp4",
          };
        });
      });
  }

  global.ExcalicordNativeBridge = {
    protocolVersion: 1,
    baseUrl: BASE_URL,
    health: health,
    sources: function () {
      return jsonRequest("/sources", "GET", null, 8000);
    },
    start: function (settings) {
      return jsonRequest("/start", "POST", settings, 30000);
    },
    pause: function () {
      return jsonRequest("/pause", "POST", {}, 3000);
    },
    resume: function () {
      return jsonRequest("/resume", "POST", {}, 3000);
    },
    stop: function () {
      return jsonRequest("/stop", "POST", {}, 30000);
    },
    status: function () {
      return jsonRequest("/status", "GET", null, 1500);
    },
    saveFolder: function () {
      return jsonRequest("/save-folder", "GET", null, 1500);
    },
    chooseSaveFolder: function () {
      return jsonRequest("/save-folder/choose", "POST", {}, 120000);
    },
    openSaveFolder: function () {
      return jsonRequest("/save-folder/open", "POST", {}, 3000);
    },
    openLastRecording: function () {
      return jsonRequest("/recording/open", "POST", {}, 3000);
    },
    saveBrowserRecording: function (blob, fileName) {
      return blobRequest("/browser-recording", blob, fileName, 120000);
    },
    downloadLastRecording: downloadLastRecording,
  };
})(window);
