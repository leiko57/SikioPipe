declare module "worker_threads" {
  interface WorkerOptions {
    type?: "module" | "commonjs";
  }
}

declare module "node:worker_threads" {
  interface WorkerOptions {
    type?: "module" | "commonjs";
  }
}
