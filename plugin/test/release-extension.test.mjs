import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { previousRelease, publishRelease, releaseMetadata } from "../../js/scripts/release-extension.mjs";

const sourceCommit = "a".repeat(40);
const distributionCommit = "b".repeat(40);
const artifactHash = "c".repeat(64);
const repository = "itMrBoy/cdpHelper";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdphelper-release-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
async function bundleFixture(t, { previousTag = null } = {}) {
  const bundle = await workspace(t);
  const assets = path.join(bundle, "assets");
  await fs.mkdir(assets);
  const version = "0.1.11";
  const tag = `v${version}`;
  const extensionFilename = `cdphelper-extension-${tag}.zip`;
  const extension = Buffer.from("fixture extension ZIP bytes");
  const manifest = {
    plugin_version: version,
    extension_version: version,
    source_commit: sourceCommit,
    distribution_commit: distributionCommit,
    source_dirty: false,
    previous_release_tag: previousTag,
    protocol_version: 2,
    plugin_artifact: { sha256: artifactHash },
    extension: { filename: extensionFilename, sha256: hash(extension), files: { "manifest.json": "d".repeat(64) } },
  };
  await fs.writeFile(path.join(assets, extensionFilename), extension);
  await writeJSON(path.join(assets, "release-manifest.json"), manifest);
  await fs.writeFile(
    path.join(assets, "SHA256SUMS"),
    `${hash(extension)}  ${extensionFilename}\n${hash(await fs.readFile(path.join(assets, "release-manifest.json")))}  release-manifest.json\n`,
  );
  const marker = `<!-- cdphelper-release ${tag} ${sourceCommit} ${distributionCommit} ${artifactHash} -->`;
  const notes = marker + "\n\n# cdpHelper release\n\nChanges from the previous version.\n";
  await fs.writeFile(path.join(bundle, "release-notes.md"), notes);
  const assetHashes = {};
  for (const name of await fs.readdir(assets)) assetHashes[name] = hash(await fs.readFile(path.join(assets, name)));
  const plan = {
    version,
    tag,
    source_commit: sourceCommit,
    distribution_commit: distributionCommit,
    artifact_sha256: artifactHash,
    previous_release_tag: previousTag,
    marker,
    notes_sha256: hash(notes),
    assets: assetHashes,
  };
  await writeJSON(path.join(bundle, "release-plan.json"), plan);
  return { bundle, manifest, plan, assets };
}

function remote({ releases = [], manifest, draft, tags } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "git") {
      assert.deepEqual(args.slice(0, 2), ["ls-remote", `https://github.com/${repository}.git`]);
      if (tags !== undefined) return tags;
      const published = releases.find((item) => !item.isDraft && args[2] === `refs/tags/${item.tagName}`);
      return published && manifest ? `${manifest.distribution_commit}\trefs/tags/${published.tagName}\n` : "";
    }
    assert.equal(command, "gh", "all external commands must be explicitly stubbed");
    assert.equal(args[args.indexOf("--repo") + 1], repository);
    if (args[1] === "list") return JSON.stringify(releases);
    if (args[1] === "download") return JSON.stringify(manifest);
    if (args[1] === "view") return JSON.stringify(draft);
    assert.ok(["create", "upload", "edit"].includes(args[1]), "unexpected gh command");
    return "";
  };
  return { calls, run };
}
const writes = (calls) =>
  calls.filter(({ command, args }) => command === "gh" && ["create", "upload", "edit"].includes(args[1]));

test("publishing creates a draft, uploads only the three verified assets, then publishes at exact B", async (t) => {
  const { bundle, plan } = await bundleFixture(t);
  const { run, calls } = remote();
  assert.deepEqual(await publishRelease({ bundle, run }), { published: true, skipped: false, tag: plan.tag });
  const actions = writes(calls);
  assert.deepEqual(
    actions.map(({ args }) => args[1]),
    ["create", "upload", "edit"],
  );
  for (const { args } of [actions[0], actions[2]]) {
    assert.equal(args[args.indexOf("--target") + 1], distributionCommit);
    assert.equal(args[2], plan.tag);
    assert.equal(args[args.indexOf("--notes-file") + 1], path.join(bundle, "release-notes.md"));
  }
  assert.ok(actions[0].args.includes("--draft"));
  assert.ok(actions[2].args.includes("--draft=false"));
  assert.deepEqual(
    actions[1].args
      .slice(actions[1].args.indexOf("--clobber") + 1)
      .map((file) => path.basename(file))
      .sort(),
    ["SHA256SUMS", "cdphelper-extension-v0.1.11.zip", "release-manifest.json"].sort(),
  );
});

test("an identical already-published release is read-only and idempotent", async (t) => {
  const { bundle, manifest, plan } = await bundleFixture(t);
  const { run, calls } = remote({ releases: [{ tagName: plan.tag, isDraft: false }], manifest });
  assert.deepEqual(await publishRelease({ bundle, run }), { published: false, skipped: true, tag: plan.tag });
  assert.deepEqual(writes(calls), []);
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["gh", "gh", "git"],
  );
});

test("published versions with a missing or misdirected tag refuse a successful skip", async (t) => {
  for (const conflict of ["missing", "wrong target"]) {
    await t.test(conflict, async (t) => {
      const { bundle, manifest, plan } = await bundleFixture(t);
      const { run, calls } = remote({
        releases: [{ tagName: plan.tag, isDraft: false }],
        manifest,
        tags: conflict === "missing" ? "" : `${"f".repeat(40)}\trefs/tags/${plan.tag}\n`,
      });
      await assert.rejects(publishRelease({ bundle, run }), /tag/);
      assert.deepEqual(writes(calls), []);
    });
  }
});

test("documentation-only new B does not move the already-published old B tag", async (t) => {
  const { bundle, manifest, plan } = await bundleFixture(t);
  const oldDistributionCommit = "d".repeat(40);
  const remoteManifest = { ...manifest, distribution_commit: oldDistributionCommit };
  const { run, calls } = remote({
    releases: [{ tagName: plan.tag, isDraft: false }],
    manifest: remoteManifest,
    tags: `${oldDistributionCommit}\trefs/tags/${plan.tag}\n`,
  });
  assert.notEqual(remoteManifest.distribution_commit, plan.distribution_commit);
  assert.deepEqual(await publishRelease({ bundle, run }), { published: false, skipped: true, tag: plan.tag });
  assert.deepEqual(writes(calls), []);
  assert.equal(calls.at(-1).command, "git");
});

test("a newer published stable version blocks moving Latest backwards before any writes", async (t) => {
  const { bundle } = await bundleFixture(t);
  const { run, calls } = remote({ releases: [{ tagName: "v0.2.0", isDraft: false }] });
  await assert.rejects(publishRelease({ bundle, run }), /Latest backwards/);
  assert.deepEqual(writes(calls), []);
  assert.equal(calls.length, 1, "the conflict must be rejected immediately after the release listing");
});

test("a higher public prerelease does not block a stable publication", async (t) => {
  const { bundle } = await bundleFixture(t);
  const { run, calls } = remote({
    releases: [{ tagName: "v0.2.0", isDraft: false, isPrerelease: true }],
  });
  assert.equal((await publishRelease({ bundle, run })).published, true);
  assert.deepEqual(
    writes(calls).map(({ args }) => args[1]),
    ["create", "upload", "edit"],
  );
  assert.equal(calls[0].args[calls[0].args.indexOf("--json") + 1], "tagName,isDraft,isPrerelease");
});

test("a lower public prerelease does not become the stable changelog baseline", async (t) => {
  const { bundle } = await bundleFixture(t, { previousTag: "v0.1.9" });
  const { run, calls } = remote({
    releases: [
      { tagName: "v0.1.9", isDraft: false, isPrerelease: false },
      { tagName: "v0.1.10", isDraft: false, isPrerelease: true },
    ],
  });
  assert.equal((await publishRelease({ bundle, run })).published, true);
  assert.deepEqual(
    writes(calls).map(({ args }) => args[1]),
    ["create", "upload", "edit"],
  );
});

test("the current tag being a public prerelease refuses a stable overwrite", async (t) => {
  const { bundle, manifest, plan } = await bundleFixture(t);
  const { run, calls } = remote({
    releases: [{ tagName: plan.tag, isDraft: false, isPrerelease: true }],
    manifest,
  });
  await assert.rejects(publishRelease({ bundle, run }), /already a public prerelease/);
  assert.deepEqual(writes(calls), []);
  assert.equal(calls.length, 1, "the prerelease conflict must be rejected before downloading or inspecting a tag");
});

test("a changed published changelog baseline requires rebuilding the bundle", async (t) => {
  for (const previousTag of [null, "v0.1.9"]) {
    await t.test(String(previousTag), async (t) => {
      const { bundle } = await bundleFixture(t, { previousTag });
      const { run, calls } = remote({ releases: [{ tagName: "v0.1.10", isDraft: false }] });
      await assert.rejects(publishRelease({ bundle, run }), /baseline changed.*rerun/);
      assert.deepEqual(writes(calls), []);
      assert.equal(calls.length, 1);
    });
  }
});

test("an unchanged semantically highest baseline allows publishing and ignores newer drafts", async (t) => {
  const { bundle, plan } = await bundleFixture(t, { previousTag: "v0.1.10" });
  const { run, calls } = remote({
    releases: [
      { tagName: "v0.1.9", isDraft: false },
      { tagName: "v0.2.0", isDraft: true },
      { tagName: "v0.1.10", isDraft: false },
    ],
  });
  assert.deepEqual(await publishRelease({ bundle, run }), { published: true, skipped: false, tag: plan.tag });
  assert.deepEqual(
    writes(calls).map(({ args }) => args[1]),
    ["create", "upload", "edit"],
  );
});

test("same-version source, plugin, and extension conflicts refuse all writes", async (t) => {
  for (const mismatch of ["source", "plugin", "extension"]) {
    await t.test(mismatch, async (t) => {
      const { bundle, manifest, plan } = await bundleFixture(t);
      const changed = structuredClone(manifest);
      if (mismatch === "source") changed.source_commit = "d".repeat(40);
      else if (mismatch === "plugin") changed.plugin_artifact.sha256 = "e".repeat(64);
      else changed.extension.files["manifest.json"] = "f".repeat(64);
      const { run, calls } = remote({ releases: [{ tagName: plan.tag, isDraft: false }], manifest: changed });
      await assert.rejects(publishRelease({ bundle, run }), /published/);
      assert.deepEqual(writes(calls), []);
    });
  }
});

test("a matching draft resumes upload and publication without creating another draft", async (t) => {
  const { bundle, plan } = await bundleFixture(t);
  const { run, calls } = remote({
    releases: [{ tagName: plan.tag, isDraft: true }],
    draft: { body: plan.marker + "\nexisting candidate", targetCommitish: distributionCommit },
  });
  assert.equal((await publishRelease({ bundle, run })).published, true);
  assert.deepEqual(
    writes(calls).map(({ args }) => args[1]),
    ["upload", "edit"],
  );
});

test("foreign drafts and existing tags pointing outside B are never overwritten", async (t) => {
  for (const conflict of ["foreign marker", "wrong draft target", "wrong tag target"]) {
    await t.test(conflict, async (t) => {
      const { bundle, plan } = await bundleFixture(t);
      const { run, calls } = remote({
        releases: conflict === "wrong tag target" ? [] : [{ tagName: plan.tag, isDraft: true }],
        draft: {
          body: conflict === "foreign marker" ? "unrelated release" : plan.marker,
          targetCommitish: conflict === "wrong draft target" ? "e".repeat(40) : distributionCommit,
        },
        tags: conflict === "wrong tag target" ? `${"f".repeat(40)}\trefs/tags/${plan.tag}\n` : "",
      });
      await assert.rejects(publishRelease({ bundle, run }));
      assert.deepEqual(writes(calls), []);
    });
  }
});

test("an annotated tag is checked against its peeled commit rather than its tag-object SHA", async (t) => {
  const { bundle, plan } = await bundleFixture(t);
  const { run, calls } = remote({
    tags: `${"f".repeat(40)}\trefs/tags/${plan.tag}\n${distributionCommit}\trefs/tags/${plan.tag}^{}\n`,
  });
  assert.equal((await publishRelease({ bundle, run })).published, true);
  assert.equal(writes(calls).length, 3);
});

test("tampered assets and notes fail before any external command", async (t) => {
  for (const item of ["ZIP", "manifest", "checksums", "notes", "extra asset"]) {
    await t.test(item, async (t) => {
      const { bundle, assets } = await bundleFixture(t);
      const file =
        item === "notes"
          ? path.join(bundle, "release-notes.md")
          : path.join(
              assets,
              {
                ZIP: "cdphelper-extension-v0.1.11.zip",
                manifest: "release-manifest.json",
                checksums: "SHA256SUMS",
                "extra asset": "unexpected.zip",
              }[item],
            );
      await fs.writeFile(file, "tampered bytes\n");
      const { run, calls } = remote();
      await assert.rejects(publishRelease({ bundle, run }));
      assert.deepEqual(calls, []);
    });
  }
});

test("previous release discovery orders semantic versions and validates the prior manifest", async () => {
  const manifest = { plugin_version: "0.1.10", source_dirty: false, source_commit: sourceCommit };
  const { run, calls } = remote({
    releases: ["v0.1.9", "v0.1.10", "v0.1.11", "preview", "v0.1.12-rc.1"].map((tagName) => ({ tagName })),
    manifest,
  });
  assert.deepEqual(await previousRelease("0.1.11", run), { ...manifest, release_tag: "v0.1.10" });
  assert.ok(calls[0].args.includes("--exclude-drafts"));
  assert.ok(calls[0].args.includes("--exclude-pre-releases"));
  assert.equal(calls[1].args[2], "v0.1.10");
});

test("previous release discovery handles first release and refuses out-of-order versions", async () => {
  assert.equal(await previousRelease("0.1.0", remote().run), null);
  const { run, calls } = remote({ releases: [{ tagName: "v0.2.0" }] });
  await assert.rejects(previousRelease("0.1.11", run), /newer extension version/);
  assert.equal(calls.length, 1);
});

test("previous manifests require matching versions, clean source, and a full source SHA", async (t) => {
  for (const mismatch of ["version", "dirty", "SHA"]) {
    await t.test(mismatch, async () => {
      const manifest = {
        plugin_version: mismatch === "version" ? "0.1.8" : "0.1.10",
        source_dirty: mismatch === "dirty",
        source_commit: mismatch === "SHA" ? "abc" : sourceCommit,
      };
      const { run } = remote({ releases: [{ tagName: "v0.1.10" }], manifest });
      await assert.rejects(previousRelease("0.1.11", run));
    });
  }
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
}
async function initialize(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  for (const [key, value] of [
    ["user.name", "Release test"],
    ["user.email", "release-test@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.hooksPath", path.join(root, ".git/empty-hooks")],
  ])
    git(root, "config", key, value);
}
test("release metadata uses source A recorded by exact pinned distribution B", async (t) => {
  const base = await workspace(t);
  const tooling = path.join(base, "tooling");
  const distribution = path.join(base, "distribution");
  await initialize(tooling);
  await initialize(distribution);
  await writeJSON(path.join(distribution, "plugins/cdphelper/artifact.json"), {
    version: "0.1.11",
    source_commit: sourceCommit,
    source_dirty: false,
  });
  git(distribution, "add", ".");
  git(distribution, "commit", "-m", "distribution fixture");
  const pinned = git(distribution, "rev-parse", "HEAD");
  await writeJSON(path.join(tooling, "plugin/version.json"), { version: "0.1.11" });
  git(tooling, "add", ".");
  git(tooling, "update-index", "--add", "--cacheinfo", `160000,${pinned},cdpHelper`);
  git(tooling, "commit", "-m", "pin B fixture");
  assert.deepEqual(await releaseMetadata({ tooling, distribution }), {
    version: "0.1.11",
    tag: "v0.1.11",
    source_commit: sourceCommit,
    distribution_commit: pinned,
  });
  await fs.writeFile(path.join(distribution, "dirty.txt"), "keep local changes\n");
  await assert.rejects(releaseMetadata({ tooling, distribution }), /clean/);
});
