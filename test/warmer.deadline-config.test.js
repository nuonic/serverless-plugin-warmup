/* global jest describe it expect */
const { getConfigsByWarmer } = require('../src/config');
const { extendServerlessSchema } = require('../src/schema');
const { getServerlessConfig } = require('./utils/configUtils');

function configure(options) {
  return getConfigsByWarmer(getServerlessConfig({ service: {
    custom: { warmup: { default: { enabled: true, ...options } } },
    functions: { target: { name: 'target' } },
  } }), 'dev').default;
}

describe('warmer deadline configuration', () => {
  it('defaults to a 30-second warmer and 20-second invocation deadline', () => {
    expect(configure({})).toMatchObject({ timeout: 30, invokeTimeout: 20, memorySize: 128 });
  });

  it('preserves explicitly configured deadlines and memory', () => {
    expect(configure({ timeout: 45, invokeTimeout: 25, memorySize: 256 }))
      .toMatchObject({ timeout: 45, invokeTimeout: 25, memorySize: 256 });
  });

  it('declares invocation timeout as a positive number in the warmer schema', () => {
    const defineCustomProperties = jest.fn();
    extendServerlessSchema({ configSchemaHandler: { defineCustomProperties } });
    const warmerSchema = defineCustomProperties.mock.calls[0][0].properties.warmup.patternProperties['.*'];
    expect(warmerSchema.properties.invokeTimeout).toEqual({ type: 'number', exclusiveMinimum: 0, maximum: 900 });
  });
});
