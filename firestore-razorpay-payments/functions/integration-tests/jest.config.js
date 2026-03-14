module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '..',
    roots: ['<rootDir>/integration-tests'],
    testMatch: ['**/integration-test.spec.ts'],
    testTimeout: 30000,
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },
};
