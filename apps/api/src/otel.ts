/**
 * Request tracing with OpenTelemetry, on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (any OTLP
 * backend: Grafana Tempo, Honeycomb, Jaeger, Sentry…). Traces cover incoming HTTP requests, every
 * Postgres query and outgoing calls (Paystack, Meta, Supabase, Claude). Imported first by main.ts so
 * the instrumentation is in place before `pg` and `http` load.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

export const tracing = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (tracing) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'trawer-api',
    instrumentations: [
      // Static files and health checks are noise; API and page requests are what matter.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /^\/(assets|media)\/|^\/api\/health/.test(req.url ?? '') }),
      // Query text only, never the values (they can hold phone numbers and names).
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => { void sdk.shutdown().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
