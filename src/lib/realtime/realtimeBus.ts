import { randomUUID } from "crypto";
import type { Server as SocketIOServer } from "socket.io";
import redis from "../../config/redis";
import logger from "../logger";

const CHANNEL = "cleaning-crm:realtime:v1";
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
        logger.warn(`[Realtime] publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const startRealtimeSubscriber = (io: SocketIOServer) => {
    const subscriber = redis.duplicate();
    subscriber.on("error", (error) => {
        logger.warn(`[Realtime] subscriber unavailable: ${error.message}`);
    });

    subscriber.on("message", (_channel, raw) => {
        try {
            const message = JSON.parse(raw) as RealtimeEnvelope;
            if (!message || message.source === instanceId || !message.target || !message.event) return;
            emitEnvelope(io, message);
        } catch (error) {
            logger.warn(`[Realtime] ignored malformed message: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    void subscriber.subscribe(CHANNEL).catch((error) => {
        logger.warn(`[Realtime] subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return subscriber;
};

export { instanceId as realtimeInstanceId };
export type { RealtimeTarget };
