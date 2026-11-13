/* global jest */

/* eslint-disable max-classes-per-file, no-multi-assign */
class GeneratedFunctionTester {
  constructor(func) {
    this.func = func;
    const lambdaInstances = this.lambdaInstances = [];
    const aws = this.aws = {
      config: {},
      LambdaClient: class LambdaClient {
        constructor(config) {
          aws.config = config;
          const invoke = jest.fn().mockResolvedValue({ StatusCode: 200 });
          this.send = (command) => invoke(command);
          lambdaInstances.push(invoke);
        }
      },
      InvokeCommand: class InvokeCommand {
        constructor(params) {
          Object.keys(params).forEach((key) => {
            this[key] = params[key];
          });
        }
      },
    };
  }
  /* eslint-enable max-classes-per-file, no-multi-assign */

  generatedWarmupFunction() {
    // eslint-disable-next-line no-new-func
    return new Function('dependencies', 'process', 'console', `
      const require = (dep) => {
        if (!dependencies[dep]) {
          throw new Error(\`Unknow dependency (\${dep})\`);
        }

        return dependencies[dep];
      };
      const module = { exports: {} };
      ${this.func
    .replaceAll(/import (\{.*\}) from ('.*');/g, 'const $1 = require($2);')
    .replace('export const warmUp', 'module.exports.warmUp')}
      return module.exports.warmUp({}, { getRemainingTimeInMillis: () => 30000 });
    `);
  }

  executeWarmupFunction(args = {}) {
    return this.generatedWarmupFunction()(
      {
        '@aws-sdk/client-lambda': this.aws,
        '@smithy/node-http-handler': { NodeHttpHandler: class NodeHttpHandler {} },
      },
      args.process || { env: {} },
      args.console || { log: () => {}, error: () => {} },
    );
  }
}

module.exports = { GeneratedFunctionTester };
