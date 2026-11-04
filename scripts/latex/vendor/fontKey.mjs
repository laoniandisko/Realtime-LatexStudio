/* MIT licensed, adapted from HenryXiaoYang/realtime-tex-vsc-plugin. See LICENSE. */
function fontKey(desc) {
  if (desc.filename) return `file:${desc.filename}#${desc.subfont ?? 0}`;
  return `tfm:${desc.name ?? desc.id}`;
}
export {
  fontKey
};
