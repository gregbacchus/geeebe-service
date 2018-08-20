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
  testURL: 'http://localhost',
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
};
