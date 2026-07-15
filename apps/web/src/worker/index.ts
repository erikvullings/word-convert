/// <reference lib="webworker" />

import type { WorkerRequest } from './protocol.ts';
import { createWorkerRuntime } from './runtime.ts';

const scope = self as DedicatedWorkerGlobalScope;
const runtime = createWorkerRuntime((message, transfer = []) =>
  scope.postMessage(message, transfer),
);

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void runtime.handle(event.data);
});
