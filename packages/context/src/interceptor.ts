// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: @loopback/context
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  ClassDecoratorFactory,
  DecoratorFactory,
  MetadataAccessor,
  MetadataInspector,
  MethodDecoratorFactory,
} from '@loopback/metadata';
import * as assert from 'assert';
import * as debugFactory from 'debug';
import {BindingAddress} from './binding-key';
import {Context} from './context';
import {transformValueOrPromise, ValueOrPromise} from './value-promise';
const debug = debugFactory('loopback:context:intercept');
const getTargetName = DecoratorFactory.getTargetName;

// tslint:disable:no-any

/**
 * InvocationContext represents the context to invoke interceptors for a method.
 * The context can be used to access metadata about the invocation as well as
 * other dependencies.
 */
export class InvocationContext extends Context {
  /**
   * Construct a new instance of `InvocationContext`
   * @param parent Parent context, such as the RequestContext
   * @param target Target class (for static methods) or object (for instance methods)
   * @param methodName Method name
   * @param args An array of arguments
   */
  constructor(
    parent: Context,
    public readonly target: object,
    public readonly methodName: string,
    public readonly args: any[],
  ) {
    super(parent);
  }
}

/**
 * Interceptor function
 */
export interface Interceptor {
  <T = unknown>(
    context: InvocationContext,
    next: () => ValueOrPromise<T>,
  ): ValueOrPromise<T>;
}

/**
 * Interceptor or binding key that can be used as arguments for `@intercept`
 */
export type InterceptorOrKey = BindingAddress<Interceptor> | Interceptor;

/**
 * Metadata key for method-level interceptors
 */
export const INTERCEPT_METHOD_KEY = MetadataAccessor.create<
  InterceptorOrKey[],
  MethodDecorator
>('intercept:method');

/**
 * Metadata key for method-level interceptors
 */
export const INTERCEPT_CLASS_KEY = MetadataAccessor.create<
  InterceptorOrKey[],
  ClassDecorator
>('intercept:class');

/**
 * Decorator function for methods to be intercepted
 * @param interceptorOrKeys One or more interceptors or binding keys that are resolved
 * to be interceptors
 */
export function intercept(...interceptorOrKeys: InterceptorOrKey[]) {
  return function interceptDecoratorForClassOrMethod(
    target: any,
    method?: string,
    methodDescriptor?: TypedPropertyDescriptor<unknown>,
  ) {
    if (method && methodDescriptor) {
      // Method
      return MethodDecoratorFactory.createDecorator(
        INTERCEPT_METHOD_KEY,
        interceptorOrKeys,
      )(target, method, methodDescriptor!);
    }
    if (typeof target === 'function' && !method && !methodDescriptor) {
      // Class
      return ClassDecoratorFactory.createDecorator(
        INTERCEPT_CLASS_KEY,
        interceptorOrKeys,
      )(target);
    }
    // Not on a class or method
    throw new Error(
      '@intercept cannot be used on a property: ' +
        DecoratorFactory.getTargetName(target, method, methodDescriptor),
    );
  };
}

/**
 * Invoke a method with the given context
 * @param context Context object
 * @param Target Target class (for static methods) or object (for instance methods)
 * @param methodName Method name
 * @param args Argument values
 */
export function invokeMethodWithInterceptors(
  context: Context,
  target: object,
  methodName: string,
  args: any[],
) {
  const targetWithMethods = target as Record<string, Function>;
  assert(
    typeof targetWithMethods[methodName] === 'function',
    `Method ${methodName} not found`,
  );
  const invocationCtx = new InvocationContext(
    context,
    target,
    methodName,
    args,
  );

  const interceptors =
    MetadataInspector.getMethodMetadata(
      INTERCEPT_METHOD_KEY,
      target,
      methodName,
    ) || [];

  let targetClass: Function;
  if (typeof target === 'function') {
    targetClass = target;
  } else {
    targetClass = target.constructor;
  }
  const classInterceptors =
    MetadataInspector.getClassMetadata(INTERCEPT_CLASS_KEY, targetClass) || [];

  // Inserting class level interceptors before method level ones
  for (const classLevelInterceptor of classInterceptors) {
    // Skip class level interceptor as it's already applied at method level
    if (interceptors.includes(classLevelInterceptor)) continue;
    interceptors.unshift(classLevelInterceptor);
  }

  return invokeInterceptors(invocationCtx, interceptors);
}

/**
 * Invoke the interceptor chain
 * @param context Context object
 * @param interceptors An array of interceptors
 */
function invokeInterceptors(
  context: InvocationContext,
  interceptors: InterceptorOrKey[],
) {
  let index = 0;
  const next: <T>() => ValueOrPromise<T> = () => {
    // No more interceptors
    if (index === interceptors.length) {
      const targetWithMethods = context.target as Record<string, Function>;
      assert(
        typeof targetWithMethods[context.methodName] === 'function',
        `Method ${context.methodName} not found`,
      );
      if (debug.enabled) {
        debug(
          'Invoking method %s',
          getTargetName(context.target, context.methodName),
          context.args,
        );
      }
      // Invoke the target method
      return targetWithMethods[context.methodName](...context.args);
    }
    const interceptor = interceptors[index++];
    let interceptorFn: ValueOrPromise<Interceptor>;
    if (typeof interceptor !== 'function') {
      debug('Resolving interceptor binding %s', interceptor);
      interceptorFn = context.getValueOrPromise(interceptor) as ValueOrPromise<
        Interceptor
      >;
    } else {
      interceptorFn = interceptor;
    }
    return transformValueOrPromise(interceptorFn, fn => {
      if (debug.enabled) {
        debug(
          'Invoking interceptor %d on %s',
          index - 1,
          getTargetName(context.target, context.methodName),
          context.args,
        );
      }
      return fn(context, next);
    });
  };
  return next();
}
