# Third-party notices

This repository preserves the license notices of its origins and adapted code. Installing npm dependencies or the optional native runtime also installs software under its own licenses.

## Origins and adapted source

| Component | Source | License and notice |
| --- | --- | --- |
| SideX foundation | https://github.com/Sidenai/sidex | MIT; root LICENSE preserves Microsoft Corporation and Siden Technologies Inc. notices |
| Preview, glyph/source mapping and rendering adapters | https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin | MIT, Copyright (c) 2026 Henry Yang; src/latex/rtex/vendor/LICENSE and README.md |
| Resource loading and Type1 outline adapters | Same upstream preview integration | MIT, Copyright (c) 2026 Henry Yang; scripts/latex/vendor/LICENSE and source notices |
| Optional realtime-tex 0.0.6 runtime | https://github.com/HenryXiaoYang/realtime-tex | MIT; downloaded separately by the setup helper, with its upstream distribution notices |

Compatibility changes are made in a generated local copy of verified runtime assets. The official DLL is not modified or included in this source repository. TeX distributions and packages remain separate installations with their respective licenses.

## Direct application and development dependencies

| Package | License |
| --- | --- |
| @vscode/codicons | CC-BY-4.0 |
| @xterm/xterm, @xterm/addon-fit | MIT |
| monaco-editor | MIT |
| pdfjs-dist | Apache-2.0 |
| opentype.js | MIT |
| ws | MIT |
| node-pty (optional) | MIT |
| @napi-rs/canvas | MIT |
| esbuild | MIT |
| typescript | Apache-2.0 |
| @types/trusted-types | MIT |
| vite | MIT |

Codicons is provided by the Visual Studio Code project through the @vscode/codicons package. Its icon artwork is used without artwork changes. See https://github.com/microsoft/vscode-codicons and https://creativecommons.org/licenses/by/4.0/.

The lockfile records the distributed dependency versions. Consult each installed package's license and notice files for its full terms and transitive dependencies. Retain applicable notices when redistributing bundled builds; the root MIT license does not replace dependency licenses.
