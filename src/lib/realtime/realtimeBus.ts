import { randomUUID } from "crypto";
import type { Server as SocketIOServer } from "socket.io";
import redis from "../../config/redis";
import logger from "../logger";

const CHANNEL = "cleaning-crm:realtime:v1";
const SYSTEM_DISCONNECT_EVENT = "__system:disconnect-tenant-sockets";
const instanceId = randomUUID();

type RealtimeTarget =
    | { scope: "admin"; id: string }
    | { scope: "staff"; id: string }
    | { scope: "super-admins" }
    | { scope: "all" };

type RealtimeEnvelope = {
    source: string;
    target: RealtimeTarget;
    event: string;
    payload: unknown;
};

const emitEnvelope = (io: SocketIOServer, message: RealtimeEnvelope) => {
    const { target, event, payload } = message;
    if (event === SYSTEM_DISCONNECT_EVENT && target.scope === "admin") {
        io.in(`admin:${target.id}`).disconnectSockets(true);
        return;
    }
    if (target.scope === "admin") io.to(`admin:${target.id}`).emit(event, payload);
    else if (target.scope === "staff") io.to(`staff:${target.id}`).emit(event, payload);
    else if (target.scope === "super-admins") io.to("super-admins").emit(event, payload);
    else io.emit(event, payload);
};

export const publishRealtimeEvent = async (
    target: RealtimeTarget,
    event: string,
    payload: unknown,
): Promise<void> => {
    if (!event?.trim()) return;
    const message: RealtimeEnvelope = { source: instanceId, target, event, payload };
    try {
        await redis.publish(CHANNEL, JSON.stringify(message));
    } catch (error) {
        // Realtime delivery is best-effort; persisted DB state remains canonical.
        logger.warn(`Realtime update could not be published — ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const startRealtimeSubscriber = (io: SocketIOServer) => {
    // A Redis pub/sub connection can spend time in "connecting" during local
    // startup. The primary Redis client intentionally disables its offline
    // queue so request-path cache calls fail fast, but a subscriber is a
    // long-lived background connection and should wait until Redis is ready.
    const subscriber = redis.duplicate({
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
    });

    let outageLogged = false;
    let subscribed = false;

    subscriber.on("error", (error) => {
        if (outageLogged) return;
        outageLogged = true;
        logger.warn(`Realtime updates are temporarily unavailable — ${error.message}`);
    });

    subscriber.on("ready", () => {
        if (outageLogged) logger.info("Realtime connection restored.");
        outageLogged = false;
        if (subscribed) return;
        void subscriber.subscribe(CHANNEL)
            .then(() => {
                subscribed = true;
                logger.info("Realtime subscriber ready.");
            })
            .catch((error) => {
                logger.warn(`Realtime subscriber could not start — ${error instanceof Error ? error.message : String(error)}`);
            });
    });

    subscriber.on("message", (_channel, raw) => {
        try {
            const message = JSON.parse(raw) as RealtimeEnvelope;
            if (!message || message.source === instanceId || !message.target || !message.event) return;
            emitEnvelope(io, message);
        } catch {
            logger.warn("Realtime subscriber ignored an invalid message.");
        }
    });

    // duplicate() normally starts connecting immediately. If it was created in
    // a waiting state, connect explicitly; otherwise the ready listener above
    // owns subscription startup.
    if (subscriber.status === "wait") {
        void subscriber.connect().catch((error) => {
            logger.warn(`Realtime Redis connection could not start — ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    return subscriber;
};

export const publishTenantSocketDisconnect = async (adminId: string): Promise<void> => {
    await publishRealtimeEvent({ scope: "admin", id: adminId }, SYSTEM_DISCONNECT_EVENT, null);
};

export { instanceId as realtimeInstanceId };
export type { RealtimeTarget };
