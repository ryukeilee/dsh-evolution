// Application-owned contracts, not official service names.
export function requirePort(port, method, name) {
  if (typeof port?.[method] !== 'function') {
    const error = new Error(`E_CONTINUOUS_PORT_REQUIRED: ${name}.${method}`);
    error.code = 'E_CONTINUOUS_PORT_REQUIRED';
    throw error;
  }
  return port[method].bind(port);
}
export function assertMutation(authority, operation) {
  if (typeof authority?.assertMutation !== 'function') {
    const error = new Error(`E_MUTATION_AUTHORITY_REQUIRED: ${operation}`);
    error.code = 'E_MUTATION_AUTHORITY_REQUIRED';
    throw error;
  }
  authority.assertMutation(operation);
}
export function boundedCount(value, fallback, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) throw new RangeError('Continuous cycle count must be finite and nonnegative');
  return Math.min(Math.floor(number), maximum);
}
