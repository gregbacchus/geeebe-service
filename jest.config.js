module.exports = {
  moduleFileExtensions: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'json',
    'node'
  ],
  testRegex: '(/(test|spec)/.*|(\\.|/)(test|spec))\\.(tsx?)$',
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
};
