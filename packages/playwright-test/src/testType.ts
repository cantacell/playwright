/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect } from './expect';
import { currentlyLoadingFileSuite, currentTestInfo, addFatalError, setCurrentlyLoadingFileSuite } from './globals';
import { TestCase, Suite } from './test';
import { wrapFunctionWithLocation } from './transform';
import type { Fixtures, FixturesWithLocation, Location, TestType } from './types';
import { serializeError } from './util';

const testTypeSymbol = Symbol('testType');

export class TestTypeImpl {
  readonly fixtures: FixturesWithLocation[];
  readonly test: TestType<any, any>;

  constructor(fixtures: FixturesWithLocation[]) {
    this.fixtures = fixtures;

    const test: any = wrapFunctionWithLocation(this._createTest.bind(this, 'default'));
    test[testTypeSymbol] = this;
    test.expect = expect;
    test.only = wrapFunctionWithLocation(this._createTest.bind(this, 'only'));
    test.describe = wrapFunctionWithLocation(this._describe.bind(this, 'default'));
    test.describe.only = wrapFunctionWithLocation(this._describe.bind(this, 'only'));
    test.describe.configure = wrapFunctionWithLocation(this._configure.bind(this));
    test.describe.fixme = wrapFunctionWithLocation(this._describe.bind(this, 'fixme'));
    test.describe.parallel = wrapFunctionWithLocation(this._describe.bind(this, 'parallel'));
    test.describe.parallel.only = wrapFunctionWithLocation(this._describe.bind(this, 'parallel.only'));
    test.describe.serial = wrapFunctionWithLocation(this._describe.bind(this, 'serial'));
    test.describe.serial.only = wrapFunctionWithLocation(this._describe.bind(this, 'serial.only'));
    test.describe.skip = wrapFunctionWithLocation(this._describe.bind(this, 'skip'));
    test.beforeEach = wrapFunctionWithLocation(this._hook.bind(this, 'beforeEach'));
    test.afterEach = wrapFunctionWithLocation(this._hook.bind(this, 'afterEach'));
    test.beforeAll = wrapFunctionWithLocation(this._hook.bind(this, 'beforeAll'));
    test.afterAll = wrapFunctionWithLocation(this._hook.bind(this, 'afterAll'));
    test.skip = wrapFunctionWithLocation(this._modifier.bind(this, 'skip'));
    test.fixme = wrapFunctionWithLocation(this._modifier.bind(this, 'fixme'));
    test.fail = wrapFunctionWithLocation(this._modifier.bind(this, 'fail'));
    test.slow = wrapFunctionWithLocation(this._modifier.bind(this, 'slow'));
    test.setTimeout = wrapFunctionWithLocation(this._setTimeout.bind(this));
    test.step = wrapFunctionWithLocation(this._step.bind(this));
    test.use = wrapFunctionWithLocation(this._use.bind(this));
    test.extend = wrapFunctionWithLocation(this._extend.bind(this));
    test.projectSetup = wrapFunctionWithLocation(this._createTest.bind(this, 'projectSetup'));
    (test.projectSetup as any).only = wrapFunctionWithLocation(this._createTest.bind(this, 'projectSetupOnly'));
    test._extendTest = wrapFunctionWithLocation(this._extendTest.bind(this));
    test.info = () => {
      const result = currentTestInfo();
      if (!result)
        throw new Error('test.info() can only be called while test is running');
      return result;
    };
    this.test = test;
  }

  private _currentSuite(location: Location, title: string, allowedContext: 'test' | 'projectSetup' | 'any'): Suite | undefined {
    const suite = currentlyLoadingFileSuite();
    if (!suite) {
      addFatalError([
        `Playwright Test did not expect ${title} to be called here.`,
        `Most common reasons include:`,
        `- You are calling ${title} in a configuration file.`,
        `- You are calling ${title} in a file that is imported by the configuration file.`,
        `- You have two different versions of @playwright/test. This usually happens`,
        `  when one of the dependencies in your package.json depends on @playwright/test.`,
      ].join('\n'), location);
      return;
    }
    if (allowedContext === 'projectSetup' && !suite._isProjectSetup)
      addFatalError(`${title} is only allowed in a project setup file.`, location);
    else if (allowedContext === 'test' && suite._isProjectSetup)
      addFatalError(`${title} is not allowed in a project setup file.`, location);
    return suite;
  }

  private _createTest(type: 'default' | 'only' | 'skip' | 'fixme' | 'projectSetup' | 'projectSetupOnly', location: Location, title: string, fn: Function) {
    throwIfRunningInsideJest();
    let functionTitle = 'test()';
    let allowedContext: 'test' | 'projectSetup' | 'any' = 'any';
    switch (type) {
      case 'projectSetup':
      case 'projectSetupOnly':
        functionTitle = 'test.projectSetup()';
        allowedContext = 'projectSetup';
        break;
      case 'default':
        allowedContext = 'test';
        break;
    }
    const suite = this._currentSuite(location, functionTitle, allowedContext);
    if (!suite)
      return;
    const test = new TestCase(title, fn, this, location);
    test._requireFile = suite._requireFile;
    test._isProjectSetup = suite._isProjectSetup;
    suite._addTest(test);

    if (type === 'only' || type === 'projectSetupOnly')
      test._only = true;
    if (type === 'skip' || type === 'fixme') {
      test.annotations.push({ type });
      test.expectedStatus = 'skipped';
    }
    for (let parent: Suite | undefined = suite; parent; parent = parent.parent) {
      if (parent._skipped)
        test.expectedStatus = 'skipped';
    }
  }

  private _describe(type: 'default' | 'only' | 'serial' | 'serial.only' | 'parallel' | 'parallel.only' | 'skip' | 'fixme', location: Location, title: string | Function, fn?: Function) {
    throwIfRunningInsideJest();
    const suite = this._currentSuite(location, 'test.describe()', 'any');
    if (!suite)
      return;

    if (typeof title === 'function') {
      fn = title;
      title = '';
    }

    const child = new Suite(title, 'describe');
    child._requireFile = suite._requireFile;
    child._isProjectSetup = suite._isProjectSetup;
    child.location = location;
    suite._addSuite(child);

    if (type === 'only' || type === 'serial.only' || type === 'parallel.only')
      child._only = true;
    if (type === 'serial' || type === 'serial.only')
      child._parallelMode = 'serial';
    if (type === 'parallel' || type === 'parallel.only')
      child._parallelMode = 'parallel';
    if (type === 'skip' || type === 'fixme') {
      child._skipped = true;
      child._annotations.push({ type });
    }

    for (let parent: Suite | undefined = suite; parent; parent = parent.parent) {
      if (parent._parallelMode === 'serial' && child._parallelMode === 'parallel')
        addFatalError('describe.parallel cannot be nested inside describe.serial', location);
    }

    setCurrentlyLoadingFileSuite(child);
    fn!();
    setCurrentlyLoadingFileSuite(suite);
  }

  private _hook(name: 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll', location: Location, fn: Function) {
    const suite = this._currentSuite(location, `test.${name}()`, 'test');
    if (!suite)
      return;
    suite._hooks.push({ type: name, fn, location });
  }

  private _configure(location: Location, options: { mode?: 'parallel' | 'serial', retries?: number, timeout?: number }) {
    throwIfRunningInsideJest();
    const suite = this._currentSuite(location, `test.describe.configure()`, 'any');
    if (!suite)
      return;

    if (options.timeout !== undefined)
      suite._timeout = options.timeout;

    if (options.retries !== undefined)
      suite._retries = options.retries;

    if (options.mode !== undefined) {
      if (suite._parallelMode !== 'default')
        addFatalError('Parallel mode is already assigned for the enclosing scope.', location);
      suite._parallelMode = options.mode;
      for (let parent: Suite | undefined = suite.parent; parent; parent = parent.parent) {
        if (parent._parallelMode === 'serial' && suite._parallelMode === 'parallel')
          addFatalError('describe.parallel cannot be nested inside describe.serial', location);
      }
    }
  }

  private _modifier(type: 'skip' | 'fail' | 'fixme' | 'slow', location: Location, ...modifierArgs: [arg?: any | Function, description?: string]) {
    const suite = currentlyLoadingFileSuite();
    if (suite) {
      if (typeof modifierArgs[0] === 'string' && typeof modifierArgs[1] === 'function' && (type === 'skip' || type === 'fixme')) {
        // Support for test.{skip,fixme}('title', () => {})
        this._createTest(type, location, modifierArgs[0], modifierArgs[1]);
        return;
      }

      if (typeof modifierArgs[0] === 'function') {
        suite._modifiers.push({ type, fn: modifierArgs[0], location, description: modifierArgs[1] });
      } else {
        if (modifierArgs.length >= 1 && !modifierArgs[0])
          return;
        const description = modifierArgs[1];
        suite._annotations.push({ type, description });
      }
      return;
    }

    const testInfo = currentTestInfo();
    if (!testInfo) {
      addFatalError(`test.${type}() can only be called inside test, describe block or fixture`, location);
      return;
    }
    if (typeof modifierArgs[0] === 'function')
      addFatalError(`test.${type}() with a function can only be called inside describe block`, location);
    testInfo[type](...modifierArgs as [any, any]);
  }

  private _setTimeout(location: Location, timeout: number) {
    const suite = currentlyLoadingFileSuite();
    if (suite) {
      suite._timeout = timeout;
      return;
    }

    const testInfo = currentTestInfo();
    if (!testInfo) {
      addFatalError(`test.setTimeout() can only be called from a test`, location);
      return;
    }
    testInfo.setTimeout(timeout);
  }

  private _use(location: Location, fixtures: Fixtures) {
    const suite = this._currentSuite(location, `test.use()`, 'any');
    if (!suite)
      return;
    suite._use.push({ fixtures, location });
  }

  private async _step<T>(location: Location, title: string, body: () => Promise<T>): Promise<T> {
    const testInfo = currentTestInfo();
    if (!testInfo) {
      addFatalError(`test.step() can only be called from a test`, location);
      return undefined as any;
    }
    const step = testInfo._addStep({
      category: 'test.step',
      title,
      location,
      canHaveChildren: true,
      forceNoParent: false
    });
    try {
      const result = await body();
      step.complete({});
      return result;
    } catch (e) {
      step.complete({ error: serializeError(e) });
      throw e;
    }
  }

  private _extend(location: Location, fixtures: Fixtures) {
    if ((fixtures as any)[testTypeSymbol])
      throw new Error(`test.extend() accepts fixtures object, not a test object.\nDid you mean to call test._extendTest()?`);
    const fixturesWithLocation: FixturesWithLocation = { fixtures, location };
    return new TestTypeImpl([...this.fixtures, fixturesWithLocation]).test;
  }

  private _extendTest(location: Location, test: TestType<any, any>) {
    const testTypeImpl = (test as any)[testTypeSymbol] as TestTypeImpl;
    if (!testTypeImpl)
      throw new Error(`test._extendTest() accepts a single "test" parameter.\nDid you mean to call test.extend() with fixtures instead?`);
    // Filter out common ancestor fixtures.
    const newFixtures = testTypeImpl.fixtures.filter(theirs => !this.fixtures.find(ours => ours.fixtures === theirs.fixtures));
    return new TestTypeImpl([...this.fixtures, ...newFixtures]).test;
  }
}

function throwIfRunningInsideJest() {
  if (process.env.JEST_WORKER_ID) {
    throw new Error(
        `Playwright Test needs to be invoked via 'npx playwright test' and excluded from Jest test runs.\n` +
        `Creating one directory for Playwright tests and one for Jest is the recommended way of doing it.\n` +
        `See https://playwright.dev/docs/intro for more information about Playwright Test.`,
    );
  }
}

export const rootTestType = new TestTypeImpl([]);
