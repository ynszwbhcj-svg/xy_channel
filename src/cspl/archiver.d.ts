// 类型垫片：plugin-scope/utils.ts 动态 import('archiver') 的声明。
// 运行时仍需要真实的 archiver 包（npm install）；本文件仅让 tsc 通过。
// TODO(deps): 网络恢复后执行 npm install 并删除本垫片。
declare module "archiver" {
  const archiver: any;
  export default archiver;
}
