import { useEffect, useState } from 'react';

/** The value, once it has stopped changing for `ms` (search-as-you-type without a request per key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
