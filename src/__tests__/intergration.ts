// tslint:disable:no-non-null-assertion no-implicit-dependencies
import {
  testBot,
  runTestManyTimes,
  createAndRunTestResponse,
  CreateAndRunTestResponseResult,
} from '../testHelpers';
import { oneLine } from 'common-tags';
import { countBy, mapValues } from 'lodash';

describe('Public environments', () => {
  it('picks a random environment based on defined weights', async () => {
    const numTests = 1000;
    const results = await runTestManyTimes(numTests);
    const cookies = mapValues(
      countBy(results.map(result => result.responseCookies.env)),
      v => v / numTests,
    );

    expect(cookies.beta).toBeCloseTo(0.25, 1);
    expect(cookies.master).toBeCloseTo(0.75, 1);
  });

  let testResult: CreateAndRunTestResponseResult;

  describe('for requests with an existing `env` cookie', () => {
    it('does not overwrite `env` cookie if it is a valid environment', async () => {
      const results = await runTestManyTimes(300, {
        publicBranches: {
          whatever: 0.7,
          master: 0.2,
          beta: 0.1,
        },
        cookies: {
          foo: 'bar',
          env: 'whatever',
          abc: 'xyz',
        },
      });

      results.forEach(({ responseCookies: { env } }) => {
        expect(env).toBeDefined();
        expect(env).toBe('whatever');
      });
    });

    it('overwrites `env` cookie if if it is not a valid environment', async () => {
      const results = await runTestManyTimes(300, {
        publicBranches: {
          master: 1,
          beta: 1,
        },
        cookies: {
          foo: 'bar',
          env: 'nonexistent',
          abc: 'xyz',
        },
      });

      results.forEach(({ responseCookies: { env } }) => {
        expect(env).toMatch(/beta|master/);
        expect(env).not.toBe('nonexistent');
      });
    });
  });

  describe('for requests without a Cookie header,', () => {
    beforeEach(async () => {
      testResult = await createAndRunTestResponse();
    });

    it('request is routed to the same environment set in cookie', () => {
      expect(testResult.actualEnvironmentHost).toMatch(
        testResult.responseCookies.env,
      );
    });

    it('adds a Set-Cookie header to the response', () => {
      expect(testResult.response.headers['set-cookie']).toBeInstanceOf(Array);
    });

    it('Set-Cookie header includes `env` cookie', () => {
      expect(testResult.responseCookies).toHaveProperty('env');
      expect(testResult.responseCookies.env).toMatch(/beta|master/);
    });
  });

  describe('for requests with an existing Cookie header, but without an `env` cookie,', () => {
    beforeEach(async () => {
      testResult = await createAndRunTestResponse({
        uri: '/path',
        cookies: {
          foo: 'bar',
          abc: 'xyz',
        },
      });
    });

    it('request is routed to the same environment set in cookie', () => {
      expect(testResult.actualEnvironmentHost).toMatch(
        testResult.responseCookies.env,
      );
    });

    it('adds the `env` cookie to the response', async () => {
      expect(testResult.responseCookies).toHaveProperty('env');
      expect(testResult.responseCookies.env).toMatch(/beta|master/);
    });

    it('does not expire or otherwise modify unrelated cookies', async () => {
      expect(testResult.responseCookies).not.toHaveProperty('foo');

      expect(testResult.responseCookies).not.toHaveProperty('abc');
    });

    it('does not change the original `Cache-Control` header', async () => {
      testResult = await createAndRunTestResponse({
        getOriginResponseOverrides: async () => ({
          headers: {
            'cache-control': [
              {
                key: 'cache-control',
                value: 'whatever',
              },
            ],
          },
        }),
      });

      expect(testResult.response.headers['cache-control'][0].value).toMatch(
        'whatever',
      );
    });

    it('passes the requested environment `findEnvByName`', () => {
      expect(testResult.findEnvByName).toHaveBeenCalledWith(
        expect.stringMatching(/master|beta/),
      );
    });

    it('checks if path is allowed for `Set-Cookie`', async () => {
      expect(testResult.isSetCookieAllowedForPath).toHaveBeenCalledTimes(1);
      expect(testResult.isSetCookieAllowedForPath).toHaveBeenCalledWith(
        expect.stringMatching(/\/path\/?/),
      );
    });

    it('sets the response `Set-Cookie` header on allowed paths', async () => {
      expect(testResult.responseCookies).toHaveProperty('env');
      expect(testResult.responseCookies.env).toMatch(/beta|master/);
    });

    it('does not set the response `Set-Cookie` header on disallowed paths', async () => {
      testResult = await createAndRunTestResponse({
        isSetCookieAllowedForPath: () => false,
      });

      expect(testResult.responseCookies).not.toHaveProperty('env');
    });

    describe('for bots', () => {
      it('should always set `env` cookie to master', async () => {
        await testBot();
      });

      it('treats WebPageTest as a bot and always sets `env` to master', async () => {
        // tslint:disable-next-line:no-multiline-string
        await testBot(oneLine`
        Mozilla/5.0 (Linux;
        Android 4.4.2; Nexus 4 Build/KOT49H)
        AppleWebKit/537.36 (KHTML, like Gecko)
        Chrome/65.0.3325.162
        Mobile Safari/537.36
        WebPageTest
      `);
      });
    });
  });
});

describe('Branch previewing', () => {
  let testResult: CreateAndRunTestResponseResult;

  beforeEach(async () => {
    testResult = await createAndRunTestResponse({
      publicBranches: {
        master: 1,
        beta: 1,
      },
      cookies: {
        env: 'master',
        branch: 'existingInternalBranch',
      },
      findEnvByName: jest.fn(async (branch: string) => {
        if (['beta', 'master', 'existingInternalBranch'].includes(branch)) {
          return `https://${branch}.example.com`;
        }

        return undefined;
      }),
    });
  });

  it('passes the requested branch name to `findEnvByName`', async () => {
    expect(testResult.findEnvByName).toHaveBeenCalledWith(
      'existingInternalBranch',
    );
  });

  describe('Caching', () => {
    it('tells CDN not to cache the response', async () => {
      const cacheHeader = testResult.response.headers['cache-control'][0].value;
      expect(cacheHeader).toMatch(
        /no-store|proxy-revalidate|must-revalidate|s-maxage=0/,
      );
    });
  });

  describe('If the requested branch actually exists', () => {
    it('`branch` cookie always takes precedence over `env` cookie', async () => {
      const responses = await runTestManyTimes(100, {
        cookies: {
          env: 'master',
          branch: 'beta',
        },
      });

      responses.forEach(response => {
        expect(response.actualEnvironmentHost).toMatch(/beta/);
      });
    });

    it('`branch` query string parameter works like the `branch` cookie', async () => {
      const responses = await runTestManyTimes(100, {
        cookies: {
          env: 'master',
        },
        querystring: 'branch=beta',
      });

      responses.forEach(response => {
        expect(response.actualEnvironmentHost).toMatch(/beta/);
      });
    });
  });

  describe('If the requested branch does not exist', () => {
    it('fails loudly', async () => {
      expect.hasAssertions();

      try {
        await testResult.getResponse({
          cookies: {
            branch: 'nonExistingBranch',
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/find/i);
      }
    });
  });
});