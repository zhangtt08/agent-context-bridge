// 开发/CLI 服务入口：tsx server/main.ts
import { startServer } from "./index.js";

startServer().catch((e) => {
  console.error("[acb] 启动失败:", e);
  process.exit(1);
});
