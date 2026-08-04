// source: https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b

// Types for the result object with discriminated union
type Success<T> = [T, null];

type Failure<E> = [null, E];

type Result<T, E = Error> = Success<T> | Failure<E>;

// tryCatch: Fill either data or error. Check for type-safety!
// example:
// const [data, err] = await tryCatch(
//   getData(ctx, param)
// );
// if (err) {
//   throw new Error(`Not found`);
// }
export async function tryCatch<T, E = Error>(promise: Promise<T>): Promise<Result<T, E>> {
  try {
    const data = await promise;
    return [data, null];
  } catch (error) {
    return [null, error as E];
  }
}

// tryCatchSync: Non-Async. Fill either data or error. Check for type-safety!
// example:
// const [data, err] = tryCatchSync(
//   () => getData(ctx, param)
// );
// if (err) {
//   throw new Error(`Not found`);
// }
export function tryCatchSync<T, E = Error>(callback: () => T): Result<T, E> {
  try {
    const data = callback();
    return [data, null];
  } catch (error) {
    return [null, error as E];
  }
}
