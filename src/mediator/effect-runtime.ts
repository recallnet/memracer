import {
  Clock,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
} from "effect";
import type { Db } from "../db.js";

/** Database service available to mediator Effects. */
export class MediatorDatabase extends Context.Tag("memracer/MediatorDatabase")<
  MediatorDatabase,
  Db
>() {}

export type MediatorRuntime<R = MediatorDatabase> = ManagedRuntime.ManagedRuntime<R, never>;

export interface MediatorRuntimeOptions {
  readonly db: Db;
  readonly configProvider?: ConfigProvider.ConfigProvider;
  readonly clock?: Clock.Clock;
  readonly logger?: Logger.Logger<unknown, unknown>;
}

export const mediatorDatabaseLayer = (db: Db): Layer.Layer<MediatorDatabase> =>
  Layer.succeed(MediatorDatabase, db);

export const mediatorConfigLayer = (
  provider: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv(),
): Layer.Layer<never> => Layer.setConfigProvider(provider);

export const mediatorClockLayer = (
  clock: Clock.Clock = Clock.make(),
): Layer.Layer<never> => Layer.setClock(clock);

export const mediatorLoggingLayer = (
  logger: Logger.Logger<unknown, unknown> = Logger.defaultLogger,
): Layer.Layer<never> => Logger.replace(Logger.defaultLogger, logger);

export function mediatorRuntimeLayer(options: MediatorRuntimeOptions): Layer.Layer<MediatorDatabase> {
  return Layer.mergeAll(
    mediatorDatabaseLayer(options.db),
    mediatorConfigLayer(options.configProvider),
    mediatorClockLayer(options.clock),
    mediatorLoggingLayer(options.logger),
  );
}

export function makeMediatorRuntime(options: MediatorRuntimeOptions): MediatorRuntime {
  return ManagedRuntime.make(mediatorRuntimeLayer(options));
}

type EffectEither<A, E> =
  | { readonly _tag: "Left"; readonly left: E }
  | { readonly _tag: "Right"; readonly right: A };

function unwrapEffectEither<A, E>(result: EffectEither<A, E>): A {
  if (result._tag === "Left") throw result.left;
  return result.right;
}

/** Run an Effect at the Promise boundary without wrapping typed failures. */
export async function runEffectPromise<A, E, R, R2 extends R>(
  runtime: MediatorRuntime<R>,
  effect: Effect.Effect<A, E, R2>,
): Promise<A> {
  const result = await runtime.runPromise(Effect.either(effect) as Effect.Effect<
    EffectEither<A, E>,
    never,
    R
  >);
  return unwrapEffectEither(result);
}

export type EffectPromiseRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** Bind a runtime once for Promise-facing components that need no services. */
export function effectPromiseRunner<R>(runtime: MediatorRuntime<R>): EffectPromiseRunner {
  return <A, E>(effect: Effect.Effect<A, E>) => runEffectPromise(runtime, effect);
}

/** Ordinary runtime fallback for independently constructed drivers. */
export const defaultMediatorEffectRunner: EffectPromiseRunner = async <A, E>(effect: Effect.Effect<A, E>) =>
  unwrapEffectEither(await Effect.runPromise(Effect.either(effect)));
