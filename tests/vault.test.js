const test = require("node:test");
const assert = require("node:assert");
const Vault = require("../extension/vault.js");

test("encrypt/decrypt round trip with master password", async () => {
  const { key, record } = await Vault.create("correct horse", ["secret"], 1000);
  const { data } = await Vault.open("correct horse", record);
  assert.deepStrictEqual(data, ["secret"]);
  const next = await Vault.encrypt(key, ["a"]);
  assert.notStrictEqual(next.iv, record.iv);
  assert.ok(!JSON.stringify(record).includes("secret"));
});

test("absurd iteration counts in a stored record are rejected", async () => {
  const { record } = await Vault.create("correct horse", ["x"], 1000);
  await assert.rejects(Vault.open("correct horse", { ...record, iterations: 4e9 }), /Invalid vault record/);
  await assert.rejects(Vault.open("correct horse", { ...record, iterations: "1000" }), /Invalid vault record/);
});

test("wrong password and tampering are rejected", async () => {
  const { record } = await Vault.create("correct horse", ["x"], 1000);
  await assert.rejects(Vault.open("wrong", record));
  const bad = { ...record, ct: Buffer.from("tampered-data-0000").toString("base64") };
  await assert.rejects(Vault.open("correct horse", bad));
});
