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

## iOS 26/27 wifi_request_tile tilekey (morton/OSM)
- WPS tile flow: geod requests a REGION tile (`gspe85-ssl.ls.apple.com/wifi_request_tile`,
  guided by an `X-tilekey` header) and Apple returns APs *belonging to that tile*. The tilekey
  is a morton-interleaved OSM tile coordinate at zoom **13** (Apple scheme). Port validated
  against acheong08's real reference: Cardiff (51.4816,-3.1791) → **81644853**, inside the
  cluster 81644851..81644861.
- Helpers: `tilekeyForLatLng(lat,lng)` / `tilekeyToLatLng(key)` (T11 asserts roundtrip).
- **Failure mode "Current location not available" (Maps + Google Maps):** moving tile AP
  coordinates far (e.g. Yogyakarta tile `121756261` → Apple Park tile `78720159`, 13,841 km)
  leaves the returned tile internally contradictory (Yogyakarta tilekey/region, Cupertino
  coords) → geod rejects the whole response → no fix at all. Tile consistency, not parsing.
- `tilekeyRewrite=true` (DEFAULT OFF) rewrites response root f1 to the target's tile, making
  the tile region match the moved APs. If geod also validates "response tilekey == the one I
  asked for" (the phone's real tile), far-distance spoofing on the tile flow is blocked by
  design; the log (below) confirms which one it is.

## Live diagnosis on device (Shadowrocket)
- Module logs every interception. Key line after opening Maps (debug=true already set):
  `Location spoofer patched N wifi devices, ..., kind=tile, ..., tileKey=NNNNN [region=lat,lon]`
  — a kind=tile tileKey matching the PHONE's real position while target is far confirms the
  tile-consistency rejection. A kind=raw-passthrough / short body instead points at delivery
  (gzip/pattern/QUIC) or parser mismatch.
- Raw payloads: `Location spoofer raw response-original base64 ...` chunks (dumpRaw=true).
- Settings → Diagnostics → Enable Logging → VPN Logs to view.

## Test / verify
```bash
node tests/wloc.test.js   # ALL WLOC TESTS PASSED (T1-T12)
```
