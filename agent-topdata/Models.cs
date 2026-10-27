using System;

namespace PontoCamara.TopdataAgent
{
    public sealed class AgentSettings
    {
        public string ServerUrl;
        public string AgentId;
        public string AgentToken;
        public string DeviceId;
        public string DeviceHost;
        public int DevicePort;
        public int LoopSeconds;
    }

    public sealed class DeviceStatus
    {
        public string deviceId;
        public bool online;
    }

    public sealed class HeartbeatRequest
    {
        public string agentId;
        public DeviceStatus[] devices;
    }

    public sealed class SyncJob
    {
        public int id;
        public string device_id;
        public string operation;
        public string payload_json;
    }

    public sealed class JobResult
    {
        public bool ok;
        public string error;
    }

    public sealed class TopdataEvent
    {
        public string sourceId;
        public int nsr;
        public string employeeNo;
        public string occurredAt;
        public string kind;
        public string rawType;
        public string rawPayload;
    }

    public sealed class EventBatch
    {
        public string deviceId;
        public TopdataEvent[] events;
    }
}
