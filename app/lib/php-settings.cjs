'use strict';

// PHP parses each -d argument as INI source after the process argument parser.
// Quote paths explicitly: unquoted Windows short names (RUNNER~1) otherwise
// become INI expressions, and ${...} inside quoted values would be expanded.
function phpIniValue(value) {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$') + '"';
}

module.exports = { phpIniValue };
