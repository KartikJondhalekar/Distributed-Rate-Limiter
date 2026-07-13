import express from 'express';
import type { Server } from 'node:http';
import type { Logger } from '../core/interfaces';
import type { PrometheusMetrics } from './metrics';

// Metrics live on their own port, kept off the public API surface so
// scrape traffic and app traffic don't share a socket or auth boundary.
export function startMetricsServer(
    port: number,
    metrics: PrometheusMetrics,
    logger: Logger,
): Server {
    const app = express();

    app.get('/metrics', (_req, res, next) => {
        void (async () => {
            try {
                res.setHeader('Content-Type', metrics.contentType);
                res.send(await metrics.metrics());
            } catch (err) {
                next(err);
            }
        })();
    });

    return app.listen(port, () => logger.info('metrics server listening', { port }));
}