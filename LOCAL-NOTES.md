# location-spoofer (local build)

Local build of the network-level iOS location spoofing technique (mekos2772/ios-location-spoofer,
based on acheong08's research): intercepts Apple's /clls/wloc responses via the MITM layer of an
on-device proxy app (Shadowrocket / Surge / Loon / Quantumult X / Stash) and rewrites Wi-Fi +
cell-tower coordinates before CoreLocation triangulation sees them. No jailbreak, no computer.

## Layout
- `location-spoofer.js` — upstream rewrite engine (unmodified). Exports internals under Node
  (`module.exports`) for testing; auto-runs `runShadowrocket()` in proxy runtimes.
- `ios-location-spoofer.sgmodule` / `-surge.sgmodule` / `.lnplugin` / `.snippet` / `.stoverride`
  — per-proxy-app module files (upstream, unmodified).
- `tests/wloc.test.js` — local end-to-end test suite (`node tests/wloc.test.js`), T1–T9.

## Protocol facts (verified against the code)
- Envelope shapes parsed from responses: `arpc` (Pascal-string locale/app/os + functionId u32 +
  payload u32), `synthetic` (8-byte prefix 00 01 .. 00 00 + u16 len), `marker` (00 00 00 01 00 00 +
  u16 len), `bare` protobuf. Plus a byte-scan fallback (`kind: raw`) for future envelope changes.
- Patch targets, all in the AppleWLoc protobuf: Wi-Fi devices (field 2 → nested location field 2:
  lat=1, lng=2, horizAcc=3 int64 varints at 1e8 scale, signed two's-complement for negatives),
  cell towers (fields 22/24 → nested field 5), and motion fields 12/13 are preserved (anti-detection).
- Write-back preserves the original envelope kind (ARPC responses stay ARPC with metadata intact).
- `patchLocation` never invents lat/lng fields — a location without both is passed through untouched.
- Fail-open: `spoofAppleResponse` throws when nothing matches; the runtime layer's
  catch → `donePassThrough()` implements the pass-through. That throw is expected behavior (T4).

## Key gotchas learned
- `Array.prototype.concat` flattens Uint8Arrays element-wise — always concat bytes manually.
- `makeVarintField` takes the plain number (handles signed 10-byte two's-complement internally).
- Reading varint values back: fields only expose raw/valueBytes; decode with `locationSummary`
  (scale 1e8) or manual varint walk.
- Setting `Accept-Encoding: identity` in the http-request prepare script is mandatory — otherwise
  gzip bodies arrive and are passed through unpatched.
- MITM hostnames: only `gs-loc.apple.com, gs-loc-cn.apple.com, gsp-ssl.ls.apple.com,
  bluedot.is.autonavi.com(.gds.alibabadns.com)` — never broad `*.apple.com` wildcards.
- If MITM fails: check full trust in Settings → General → About → Certificate Trust Settings,
  disable QUIC/HTTP3, reconnect VPN, toggle Location Services off/on.

## Test / verify
```bash
node tests/wloc.test.js   # ALL WLOC TESTS PASSED (T1-T9)
```
