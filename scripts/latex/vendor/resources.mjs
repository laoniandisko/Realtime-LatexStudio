/* MIT licensed, adapted from HenryXiaoYang/realtime-tex-vsc-plugin. See LICENSE. */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { fontKey } from "./fontKey.mjs";
import { parseEncFile, parseMapFile, type1Outlines } from "./type1.mjs";
class ResourceLoader {
  constructor(env, log = () => void 0) {
    this.env = env;
    this.log = log;
  }
  kpseCache = /* @__PURE__ */ new Map();
  mapFile;
  fonts = /* @__PURE__ */ new Map();
  /** Font resources needed by `dls` that are not in `have`, keyed by fontKey. */
  async fontsFor(dls, have) {
    const want = /* @__PURE__ */ new Map();
    for (const dl of dls) {
      for (const desc of Object.values(dl.fonts ?? {})) {
        const k = fontKey(desc);
        if (!have.has(k) && !want.has(k)) want.set(k, desc);
      }
    }
    const out = /* @__PURE__ */ new Map();
    await Promise.all(
      [...want].map(async ([k, desc]) => {
        out.set(k, await this.font(k, desc));
      })
    );
    return out;
  }
  /** Image files referenced by `dls` (images_info) that are not in `have`, keyed by file name. */
  async imagesFor(dls, have, projectRoot) {
    const want = /* @__PURE__ */ new Set();
    for (const dl of dls) {
      for (const info of Object.values(dl.images_info ?? {})) {
        if (info.file && !info.cached_picture && !have.has(info.file)) want.add(info.file);
      }
    }
    const out = /* @__PURE__ */ new Map();
    await Promise.all([...want].map(async (f) => out.set(f, await this.image(f, projectRoot))));
    return out;
  }
  font(key, desc) {
    let p = this.fonts.get(key);
    if (!p) {
      p = this.loadFont(desc).catch((e) => ({ kind: "missing", reason: e.message }));
      this.fonts.set(key, p);
    }
    return p;
  }
  async loadFont(desc) {
    if (desc.filename) {
      const file2 = await this.locate(desc.filename);
      if (!file2) return { kind: "missing", reason: `font file not found: ${desc.filename}` };
      const lower = file2.toLowerCase();
      if (lower.endsWith(".otf") || lower.endsWith(".ttf")) {
        return { kind: "sfnt", data: new Uint8Array(await fs.readFile(file2)) };
      }
      if (lower.endsWith(".pfb") || lower.endsWith(".pfa")) {
        const entry2 = desc.name ? (await this.map()).get(desc.name) : void 0;
        return this.loadType1(file2, entry2);
      }
      return { kind: "missing", reason: `unsupported font format: ${path.basename(file2)}` };
    }
    const name = desc.name ?? "";
    const entry = (await this.map()).get(name);
    if (!entry?.fontFile) return { kind: "missing", reason: `no outline font for ${name} in pdftex.map` };
    const file = await this.locate(entry.fontFile);
    if (!file) return { kind: "missing", reason: `font file not found: ${entry.fontFile}` };
    if (/\.(otf|ttf)$/i.test(file)) return { kind: "missing", reason: `TFM font mapped to OpenType (${entry.fontFile})` };
    return this.loadType1(file, entry);
  }
  async loadType1(file, entry) {
    let encoding;
    if (entry?.encFile) {
      const encPath = await this.locate(entry.encFile);
      if (encPath) encoding = parseEncFile(await fs.readFile(encPath, "latin1"));
    }
    const { upem, glyphs } = type1Outlines(new Uint8Array(await fs.readFile(file)), encoding);
    return { kind: "type1", upem, glyphs, slant: entry?.slant, extend: entry?.extend };
  }
  async image(file, projectRoot) {
    const candidates = path.isAbsolute(file) ? [file] : [path.join(projectRoot, file)];
    for (const c of candidates) {
      try {
        const data = new Uint8Array(await fs.readFile(c));
        const ext = path.extname(c).toLowerCase();
        if (ext === ".pdf") return { kind: "pdf", mime: "application/pdf", data };
        const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "";
        if (!mime) return { kind: "missing", reason: `unsupported image format ${ext}` };
        return { kind: "bitmap", mime, data };
      } catch {
      }
    }
    return { kind: "missing", reason: `image not found: ${file}` };
  }
  async map() {
    if (!this.mapFile) {
      this.mapFile = (async () => {
        const file = await this.kpsewhich("pdftex.map");
        if (!file) {
          this.log("pdftex.map not found: Type1 (TFM) fonts will render from the PDF");
          return /* @__PURE__ */ new Map();
        }
        return parseMapFile(await fs.readFile(file, "utf8"));
      })();
    }
    return this.mapFile;
  }
  async locate(file) {
    if (path.isAbsolute(file)) {
      try {
        await fs.access(file);
        return file;
      } catch {
        return this.kpsewhich(path.basename(file));
      }
    }
    return this.kpsewhich(file);
  }
  kpsewhich(file) {
    let p = this.kpseCache.get(file);
    if (!p) {
      p = new Promise((resolve) => {
        execFile("kpsewhich", [file], { env: this.env, timeout: 1e4, windowsHide: true }, (err, stdout) => {
          const out = stdout?.trim().split("\n")[0];
          resolve(err || !out ? void 0 : out);
        });
      });
      this.kpseCache.set(file, p);
    }
    return p;
  }
}
export {
  ResourceLoader
};
