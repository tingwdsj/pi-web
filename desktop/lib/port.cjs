"use strict";

// Pick a free TCP port by letting the OS assign one (listen on port 0),
// then closing the server and returning the assigned port. No external deps.
// There is a tiny TOCTOU race (port could be taken between close and the Next
// server binding), but it is negligible for a single-user localhost desktop app.
const net = require("net");

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { pickFreePort };
