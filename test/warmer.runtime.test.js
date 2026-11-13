/* eslint-disable max-classes-per-file, class-methods-use-this */
/* global jest beforeEach afterEach describe it expect */
const vm = require('vm');
const fs = require('fs').promises;
const { createWarmUpFunctionArtifact } = require('../src/warmer');

jest.mock('fs', () => ({ promises: { mkdir: jest.fn(), writeFile: jest.fn() } }));

async function runtime(send, { concurrency = 1, remaining = 30000, invokeTimeout = 20, verbose = true } = {}) {
  await createWarmUpFunctionArtifact([
    { name: 'target', config: { concurrency, payload: '{"source":"serverless-plugin-warmup"}' } },
  ], false, verbose, 'ap-southeast-2', 'output', invokeTimeout);
  const source = fs.writeFile.mock.calls.at(-1)[1]
    .replace("import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';", '')
    .replace('export const warmUp =', 'globalThis.warmUp =');
  const log = jest.fn();
  const error = jest.fn();
  const context = {
    Buffer, AbortController, Date, setTimeout, clearTimeout,
    process: { env: {} }, console: { log, error },
    LambdaClient: class { send(...args) { return send(...args); } },
    InvokeCommand: class { constructor(input) { this.input = input; } },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { run: () => context.warmUp({}, { getRemainingTimeInMillis: () => remaining }), log, error };
}

beforeEach(() => { jest.useFakeTimers(); fs.writeFile.mockClear(); });
afterEach(() => { jest.useRealTimers(); });

describe('generated warmer runtime', () => {
  it('reports successes and preserves the warm-up payload', async () => {
    const send = jest.fn().mockResolvedValue({ StatusCode: 200 });
    const { run, log } = await runtime(send, { verbose: false });
    expect(await run()).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect(send.mock.calls[0][0].input).toMatchObject({ InvocationType: 'RequestResponse', Payload: '{"source":"serverless-plugin-warmup"}' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Warm Up Finished with 0 invoke errors'));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('allows a 10.4-second cold target to finish while warming 42 calls in parallel', async () => {
    const send = jest.fn().mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ StatusCode: 200 }), send.mock.calls.length === 1 ? 10400 : 1);
    }));
    const { run } = await runtime(send, { concurrency: 42 });
    const result = run();
    expect(send).toHaveBeenCalledTimes(42);
    await jest.advanceTimersByTimeAsync(10400);
    expect(await result).toEqual({ succeeded: 42, failed: 0, skipped: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts target FunctionError responses as failures', async () => {
    const { run, error } = await runtime(jest.fn().mockResolvedValue({ FunctionError: 'Unhandled' }));
    expect(await run()).toEqual({ succeeded: 0, failed: 1, skipped: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('reason=target-failure'), expect.anything());
  });

  it('classifies throttling separately', async () => {
    const failure = new Error('Rate exceeded'); failure.name = 'TooManyRequestsException';
    const { run, error } = await runtime(jest.fn().mockRejectedValue(failure));
    expect((await run()).failed).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('reason=throttled'), failure);
  });

  it.each([[30000, 20000], [10000, 8000]])('aborts before the warmer deadline with %i ms remaining', async (remaining, deadline) => {
    const send = jest.fn((_command, { abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => {
        const failure = new Error('Aborted'); failure.name = 'AbortError'; reject(failure);
      });
    }));
    const { run, error } = await runtime(send, { remaining });
    const result = run();
    await jest.advanceTimersByTimeAsync(deadline - 1);
    expect(error).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ succeeded: 0, failed: 1, skipped: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('reason=deadline-exceeded'), expect.anything());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('honours a custom invocation timeout', async () => {
    const send = jest.fn((_command, { abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => { const failure = new Error(); failure.name = 'AbortError'; reject(failure); });
    }));
    const { run } = await runtime(send, { invokeTimeout: 3 });
    const result = run(); await jest.advanceTimersByTimeAsync(3000);
    expect((await result).failed).toBe(1);
  });

  it('skips calls when the summary reserve is exhausted', async () => {
    const send = jest.fn(); const { run } = await runtime(send, { remaining: 1999, concurrency: 3 });
    expect(await run()).toEqual({ succeeded: 0, failed: 0, skipped: 3 });
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for sibling calls after one fails and counts individual outcomes', async () => {
    let finish;
    const send = jest.fn().mockRejectedValueOnce(new Error('failure')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { run, log } = await runtime(send, { concurrency: 2 });
    const result = run(); await Promise.resolve(); await Promise.resolve();
    expect(log.mock.calls.some(([message]) => message.startsWith('Warm Up Finished'))).toBe(false);
    finish({ StatusCode: 200 });
    expect(await result).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects invalid concurrency without abandoning the summary', async () => {
    const send = jest.fn(); const { run } = await runtime(send, { concurrency: -1 });
    expect((await run()).failed).toBe(1); expect(send).not.toHaveBeenCalled();
  });
});
