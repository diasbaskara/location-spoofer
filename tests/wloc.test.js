// Local end-to-end test for the location spoofer (mekos2772 ios-location-spoofer).
// The upstream script exports its protobuf helpers/spoofers via module.exports when
// loaded under Node, so we can drive spoofAppleResponse / spoofArpcRequest directly
// without a proxy app. Run: node tests/wloc.test.js
var assert = require('assert');
var s = require('../location-spoofer.js');

// ---------- byte helpers (Array#concat spreads Uint8Array element-wise, so manual) ----------
function concat(ps) {
  var out = [];
  ps.forEach(function (p) { for (var i = 0; i < p.length; i++) out.push(p[i] & 255); });
  return Uint8Array.from(out);
}
function ascii(v) { var o = []; for (var i = 0; i < v.length; i++) o.push(v.charCodeAt(i)); return o; }
function pstr(v) { return concat([[ (v.length >> 8) & 255, v.length & 255 ], ascii(v)]); }
function len32(n) { return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

var TARGET = { latitude: -6.2, longitude: 106.8166 }; // Jakarta
var TARGET_SUMMARY = '-6.20000000,106.81660000';

// ---------- fixture builders (Apple-wire-shaped, made with the module's own encoders) ----------
// location submessage: lat(1)/lng(2) int64 at 1e8 scale, horizAcc(3), alt(4)
function buildLoc(lat, lng) {
  return concat([
    s.makeVarintField(1, s.coordToInt(lat)),
    s.makeVarintField(2, s.coordToInt(lng)),
    s.makeVarintField(3, 39),   // horizontalAccuracy
    s.makeVarintField(4, 530)   // altitude
  ]);
}
// wifi device: BSSID-ish varint(1) + location(2)
function buildWifiDevice(loc) { return concat([s.makeVarintField(1, 12345), s.makeLengthDelimitedField(2, loc)]); }
// cell tower: location(5)
function buildCellTower(loc) { return s.makeLengthDelimitedField(5, loc); }
// AppleWLoc payload: 2x wifi(2) + cell(22) + cell(24) + motionActivityType(12)/Confidence(13)
function buildPayload(loc) {
  return concat([
    s.makeLengthDelimitedField(2, buildWifiDevice(loc)),
    s.makeLengthDelimitedField(2, buildWifiDevice(loc)),
    s.makeLengthDelimitedField(22, buildCellTower(loc)),
    s.makeLengthDelimitedField(24, buildCellTower(loc)),
    s.makeVarintField(12, 3),   // motionActivityType
    s.makeVarintField(13, 90)   // motionActivityConfidence
  ]);
}
// Full ARPC envelope (the shape Apple actually returns on /clls/wloc)
function buildArpc(payload) {
  return concat([
    [0, 1],                       // version
    pstr('en_US'),                // locale
    pstr('com.apple.locationd'),  // app identifier
    pstr('18.5.0'),               // os version
    Uint8Array.from([0, 0, 0, 0x65]), // functionId 101 (wloc)
    len32(payload.length),
    payload
  ]);
}
function w(o) { return s.patchedPayloadSummary(o.payload); }
// verify every embedded location carries the target coords
function assertAllLocations(result) {
  var back = s.parseFields(result.payload);
  var checked = 0;
  back.forEach(function (f) {
    if ([2, 22, 24].indexOf(f.fieldNumber) >= 0 && f.wireType === 2) {
      s.parseFields(f.valueBytes).forEach(function (g) {
        if ((g.fieldNumber === 2 || g.fieldNumber === 5) && g.wireType === 2) {
          checked++;
          assert.strictEqual(s.locationSummary(g.valueBytes), TARGET_SUMMARY, 'location not patched');
        }
      });
    }
  });
  assert.strictEqual(checked, 4, 'expected 4 embedded locations');
}

var loc = buildLoc(37.3349, -122.00902); // Apple Park (default)
var payload = buildPayload(loc);

// ---- T1: ARPC envelope response (real Apple shape) ----
var t1 = s.spoofAppleResponse(buildArpc(payload), TARGET);
assert.strictEqual(t1.kind, 'arpc');
assert.strictEqual(t1.wifiCount, 2);
assert.strictEqual(t1.cellCount, 2);
assert.ok(w(t1).indexOf(TARGET_SUMMARY) >= 0);
// write-back must stay a valid ARPC envelope with metadata preserved
var back = s.parseArpc(t1.response);
assert.strictEqual(back.locale, 'en_US');
assert.strictEqual(back.appIdentifier, 'com.apple.locationd');
assert.strictEqual(back.osVersion, '18.5.0');
assert.strictEqual(back.functionId, 101);
assertAllLocations(t1);

// ---- T2: marker envelope ----
var marker = concat([
  Uint8Array.from([0, 0, 0, 1, 0, 0]),
  Uint8Array.from([(payload.length >> 8) & 255, payload.length & 255]),
  payload
]);
var t2 = s.spoofAppleResponse(marker, TARGET);
assert.strictEqual(t2.kind, 'marker');
assert.strictEqual(t2.wifiCount, 2);
assert.strictEqual(t2.cellCount, 2);
assertAllLocations(t2);

// ---- T3: bare protobuf payload ----
var t3 = s.spoofAppleResponse(payload, TARGET);
assert.strictEqual(t3.kind, 'bare');
assertAllLocations(t3);

// ---- T4: unparseable garbage — rawPassthrough (default ON) now returns the
// original bytes untouched; with rawPassthrough=false it throws like before ----
var junk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
var t4 = s.spoofAppleResponse(junk, TARGET);
assert.strictEqual(t4.kind, 'raw-passthrough');
assert.strictEqual(t4.response.length, junk.length);
assert.strictEqual(Array.from(t4.response).join(','), Array.from(junk).join(','));
assert.throws(function () {
  s.spoofAppleResponse(junk, Object.assign({}, TARGET, { rawPassthrough: false }));
}, /no patchable WLoc payload/);

// ---- T5: no-wifi/cell payload passes through unpatched (patchAppleWLocPayload keeps 0/0) ----
var motionOnly = s.makeVarintField(12, 3);
var t5p = s.patchAppleWLocPayload(motionOnly, TARGET);
assert.strictEqual(t5p.wifiCount, 0);
assert.strictEqual(t5p.cellCount, 0);
assert.strictEqual(s.patchedPayloadSummary(t5p.payload), 'no wifi/cell location fields');

// ---- T6: spoofArpcRequest — request-mode synthetic synthetic-response builder ----
var t6 = s.spoofArpcRequest(buildArpc(payload), TARGET);
assert.strictEqual(t6.wifiCount, 2);
assert.strictEqual(t6.cellCount, 2);
// synthetic responses use the APPLE_WLOC_PREFIX framing (00 01 00 00 …)
assert.strictEqual(Array.from(t6.response.slice(0, 4)).join(','), '0,1,0,0');
var t6loc = s.firstFieldByNumber(s.parseFields(t6.payload), 2);
assert.ok(s.patchedPayloadSummary(t6.payload).indexOf(TARGET_SUMMARY) >= 0);

// ---- T7: config normalization (invalid lat rejected) ----
assert.throws(function () { s.normalizeConfig({ latitude: 999 }); }, /invalid latitude/);
var norm = s.normalizeConfig({ latitude: '-6.2', longitude: '106.8166', horizontalAccuracy: '39' });
assert.strictEqual(norm.latitude, -6.2);
assert.strictEqual(norm.enabled, true);
assert.strictEqual(norm.failOpen, true);

// ---- T8: argument parsing (Shadowrocket query-string style) ----
var args = s.parseArgumentString('latitude=-6.2&longitude=106.8166&debug=true');
assert.strictEqual(args.latitude, '-6.2');
assert.strictEqual(args.debug, 'true');

// ---- T9: motion fields survive patching (anti-detection) ----
var t9 = s.spoofAppleResponse(buildArpc(payload), TARGET);
var f12 = s.firstFieldByNumber(s.parseFields(t9.payload), 12);
var f13 = s.firstFieldByNumber(s.parseFields(t9.payload), 13);
assert.ok(f12 && f13, 'motion fields must survive');

// ---- T10: payload without wifi/cell fields (motion-only) → rawPassthrough zeroes ----
var motionPayload = concat([s.makeVarintField(12, 3), s.makeVarintField(13, 90)]);
var t10 = s.spoofAppleResponse(buildArpc(motionPayload), TARGET);
assert.strictEqual(t10.wifiCount, 0);
assert.strictEqual(t10.cellCount, 0);
// kind indicates unpatched passthrough, not a synthetic rewrap
assert.ok(t10.kind.indexOf('unpatched') >= 0, 'kind should mark unpatched, got ' + t10.kind);
console.log('ALL WLOC TESTS PASSED (T1-T10)');
