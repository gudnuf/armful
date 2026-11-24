// Fixture test: bin/make-fixture.py writes a synthetic collection with the
// shape every page test relies on. No real data, ever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "fixture");

test("make-fixture writes the synthetic collection", () => {
  rmSync(OUT, { recursive: true, force: true });
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), OUT], { stdio: "inherit" });
  const data = JSON.parse(readFileSync(join(OUT, "data.json"), "utf8"));
  const { people, thumbs } = data;

  // 60 good files, then one malformed entry appended last (the page drops it, nothing shifts)
  assert.equal(data.files.length, 61);
  assert.deepEqual(data.files[60], { i: "60", w: 0, h: 0, p: [], v: 1, nf: 0 });
  assert.ok(!existsSync(join(OUT, "fx", "p60.svg")));
  const files = data.files.slice(0, 60);
  for (const f of files) assert.ok(f.w > 0 && f.h > 0, `size of ${f.i}`);
  assert.equal(files.length, 60);
  assert.equal(people.length, 12);
  assert.deepEqual(people.map((p) => p.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (let k = 1; k < people.length; k++) assert.ok(people[k - 1].n >= people[k].n, "n descending");
  assert.ok(people[0].n >= people[1].n);
  assert.deepEqual(people.filter((p) => p.x === 1).map((p) => p.id).sort((a, b) => a - b), [11, 12]);
  assert.equal(files.filter((f) => f.p.includes(1) && f.p.includes(2)).length, 9);
  assert.equal(files.filter((f) => f.p.includes(1) && f.p.includes(12)).length, 0);
  assert.equal(files.filter((f) => f.v).length, 3);
  assert.ok(!("bursts" in data));

  // n is the count of files a tap on that face would give
  for (const p of people) assert.equal(p.n, files.filter((f) => f.p.includes(p.id)).length, `n of ${p.id}`);
  // aspect ratios vary across 4:3, 3:4, 16:9, 1:1
  const ratios = new Set(files.map((f) => (f.w / f.h).toFixed(3)));
  for (const r of ["1.333", "0.750", "1.778", "1.000"]) assert.ok(ratios.has(r), `ratio ${r}`);
  // each rep points at a file containing that person, box inside it
  for (const p of people) {
    const f = files[p.rep.f];
    assert.ok(f.p.includes(p.id), `rep of ${p.id}`);
    assert.deepEqual(p.rep.box, [0, 0, Math.min(f.w, f.h)]);
  }

  // capture times: 58 timed files ascending in file order, the 2 untimed ones last
  assert.equal(data.tz, "UTC");
  const timed = files.filter((f) => "t" in f);
  assert.equal(timed.length, 58);
  assert.deepEqual(files.slice(58).map((f) => "t" in f), [false, false], "untimed files last");
  assert.ok(!("t" in data.files[60]), "the malformed entry is untimed too");
  for (const f of timed) assert.ok(Number.isInteger(f.t), "t is whole unix seconds");
  for (let k = 1; k < 58; k++) assert.ok(files[k].t > files[k - 1].t, "t strictly ascending");
  // 4 days (UTC), each with a morning and an evening cluster
  const day = (f) => new Date(f.t * 1000).toISOString().slice(0, 10);
  assert.equal(new Set(timed.map(day)).size, 4);
  for (const d of new Set(timed.map(day))) {
    const hours = timed.filter((f) => day(f) === d).map((f) => new Date(f.t * 1000).getUTCHours());
    assert.ok(hours.some((h) => h < 12) && hours.some((h) => h >= 17), `${d}: morning and evening`);
  }
  // face counts: at least as many faces as people; 0 (nobody), 1, 2-3 and 8+ (group shots) all occur
  for (const f of files) assert.ok(Number.isInteger(f.nf) && f.nf >= f.p.length, `nf of ${f.i}`);
  assert.ok(files.filter((f) => f.nf === 0).length >= 6, "6+ files without people");
  for (const f of files.filter((f) => f.nf === 0)) assert.deepEqual(f.p, []);
  assert.ok(files.some((f) => f.nf === 1));
  assert.ok(files.some((f) => f.nf >= 2 && f.nf <= 3));
  assert.ok(files.filter((f) => f.nf >= 8).length >= 2, "group shots");
  // ids are still the file positions (thumbs by {i} and by index agree)
  files.forEach((f, idx) => assert.equal(f.i, String(idx)));

  assert.deepEqual(thumbs, { wall: "fx/p{i}.svg", face: "fx/f{pid}.svg", big: "fx/p{i}.svg" });
  files.forEach((f, idx) => {
    assert.ok(existsSync(join(OUT, thumbs.wall.replace("{i}", f.i))), `wall svg ${f.i}`);
    assert.ok(existsSync(join(OUT, thumbs.big.replace("{i}", idx))), `svg by index ${idx}`);
  });
  for (const p of people) assert.ok(existsSync(join(OUT, thumbs.face.replace("{pid}", p.id))), `face svg ${p.id}`);
});

test("make-fixture is deterministic", () => {
  const a = readFileSync(join(OUT, "data.json"), "utf8");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), OUT]);
  assert.equal(readFileSync(join(OUT, "data.json"), "utf8"), a);
});
