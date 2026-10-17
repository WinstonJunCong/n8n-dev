// Imported FIRST by server.mjs. Standard output belongs to the protocol: anything else printed there corrupts the
// conversation with the assistant. console.log, info and debug all write to standard output, so they are sent to
// standard error instead, before any other module gets a chance to use them.
for (const name of ["log", "info", "debug"]) console[name] = (...args) => console.error(...args);
