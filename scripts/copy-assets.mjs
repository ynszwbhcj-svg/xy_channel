// 构建后处理：把 tsc 不会输出的运行时资源文件拷贝到 dist。
// cspl 的 configs.json 是 config.ts 通过 fs.readFileSync(__dirname) 在运行时读取的，
// tsc 只编译 .ts，不会拷贝 .json，必须在这里显式拷贝，否则 dist 里一直是旧版本。
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ASSETS = [
  ["src/cspl/configs.json", "dist/src/cspl/configs.json"],
];

for (const [src, dest] of ASSETS) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-assets] ${src} -> ${dest}`);
}
