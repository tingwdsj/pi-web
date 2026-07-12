"use strict";

// Workaround for Next.js build failing on Windows when its glob/file-tracing
// libraries (@nodelib/fs.scandir, fast-glob, @vercel/nft) wander into protected
// system directories under the user profile and get EPERM/EACCES. Examples seen
// in the wild:
//   EPERM scandir  'C:\Users\<user>\Application Data'      (legacy junction)
//   EPERM readlink 'C:\Users\<user>\AppData\Local\Intel\...' (driver data)
//
// These scans are outside the project tree and the build never needs their
// contents. So: for any path OUTSIDE the project root, swallow EPERM/EACCES
// from the filesystem methods glob/tracing libraries use, returning a benign
// empty result instead. Errors inside the project are left untouched.
//
// Loaded via NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs".
// No-op on non-Windows.

const fs = require("fs");
const path = require("path");

if (process.platform === "win32") {
  const PROJECT_ROOT = path.resolve(process.cwd());
  const isOutsideProject = (p) => {
    try {
      const resolved = path.resolve(String(p));
      const rel = path.relative(PROJECT_ROOT, resolved);
      return rel.startsWith("..") || path.isAbsolute(rel) || rel === resolved;
    } catch {
      return true;
    }
  };
  const swallow = (code, p) =>
    (code === "EPERM" || code === "EACCES") && isOutsideProject(p);

  // --- Sync methods: catch -> return safe empty. ---
  const wrapSyncArr = (name) => {
    const orig = fs[name];
    fs[name] = function (p) {
      try {
        return orig.apply(this, arguments);
      } catch (e) {
        if (swallow(e && e.code, p)) return [];
        throw e;
      }
    };
  };
  const wrapSyncStat = (name) => {
    const orig = fs[name];
    fs[name] = function (p) {
      try {
        return orig.apply(this, arguments);
      } catch (e) {
        if (swallow(e && e.code, p)) {
          // Return a fake "ENOENT-ish" stat so callers treat it as missing.
          throw e; // stat callers expect an error to skip; keep throwing but...
        }
        throw e;
      }
    };
  };

  wrapSyncArr("readdirSync");
  // readlinkSync returns a string (link target). For protected paths we must
  // NOT return the path itself (nft would see a self-referencing "symlink" and
  // throw "Recursive symlink detected"). Throw ENOENT so callers treat the
  // entry as a non-existent / skipped file instead.
  {
    const orig = fs.readlinkSync;
    fs.readlinkSync = function (p) {
      try {
        return orig.apply(this, arguments);
      } catch (e) {
        if (swallow(e && e.code, p)) {
          const masked = new Error("ENOENT (masked EPERM/EACCES): " + p);
          masked.code = "ENOENT";
          throw masked;
        }
        throw e;
      }
    };
  }

  // --- Async (callback) methods: catch -> callback with empty. ---
  const wrapAsyncArr = (name) => {
    const orig = fs[name];
    fs[name] = function (p) {
      const args = Array.prototype.slice.call(arguments);
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (!cb) return orig.apply(this, args); // promise-form: wrap minimally
      const wrapped = (err, val) => {
        if (err && swallow(err.code, p)) return cb(null, Array.isArray(val) ? val : []);
        return cb(err, val);
      };
      args[args.length - 1] = wrapped;
      return orig.apply(this, args);
    };
  };
  wrapAsyncArr("readdir");
  {
    const orig = fs.readlink;
    fs.readlink = function (p) {
      const args = Array.prototype.slice.call(arguments);
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (!cb) return orig.apply(this, args);
      const wrapped = (err, val) => {
        if (err && swallow(err.code, p)) {
          const masked = new Error("ENOENT (masked EPERM/EACCES): " + p);
          masked.code = "ENOENT";
          return cb(masked);
        }
        return cb(err, val);
      };
      args[args.length - 1] = wrapped;
      return orig.apply(this, args);
    };
  }

  // lstat/lstatSync: callers use these to decide if something is a symlink/dir.
  // Pretend protected entries don't exist by throwing ENOENT (glob skips it).
  ["lstat", "stat"].forEach((name) => {
    const orig = fs[name];
    fs[name] = function (p) {
      const args = Array.prototype.slice.call(arguments);
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (!cb) return orig.apply(this, args);
      const wrapped = (err, val) => {
        if (err && swallow(err.code, p)) {
          const e = new Error("ENOENT (masked EPERM/EACCES): " + p);
          e.code = "ENOENT";
          return cb(e);
        }
        return cb(err, val);
      };
      args[args.length - 1] = wrapped;
      return orig.apply(this, args);
    };
  });
  ["lstatSync", "statSync"].forEach((name) => {
    const orig = fs[name];
    fs[name] = function (p) {
      try {
        return orig.apply(this, arguments);
      } catch (e) {
        if (swallow(e && e.code, p)) {
          const masked = new Error("ENOENT (masked EPERM/EACCES): " + p);
          masked.code = "ENOENT";
          throw masked;
        }
        throw e;
      }
    };
  });
}
