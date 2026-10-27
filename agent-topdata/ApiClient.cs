using System;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace PontoCamara.TopdataAgent
{
    public sealed class ApiClient
    {
        private readonly string _serverUrl;
        private readonly string _agentToken;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        public ApiClient(string serverUrl, string agentToken)
        {
            _serverUrl = serverUrl.TrimEnd('/');
            _agentToken = agentToken ?? "";
        }

        public void SendHeartbeat(string agentId, string deviceId, bool online)
        {
            HeartbeatRequest payload = new HeartbeatRequest();
            payload.agentId = agentId;
            payload.devices = new DeviceStatus[] {
                new DeviceStatus { deviceId = deviceId, online = online }
            };

            Post("/api/agent/heartbeat", _json.Serialize(payload));
        }

        public SyncJob[] GetJobs(string agentId)
        {
            string body = Send("GET", "/api/agent/" + Uri.EscapeDataString(agentId) + "/jobs?limit=10", null);
            return _json.Deserialize<SyncJob[]>(body);
        }

        public void CompleteJob(int jobId, bool ok, string error)
        {
            JobResult result = new JobResult();
            result.ok = ok;
            result.error = error;
            Post("/api/agent/jobs/" + jobId + "/result", _json.Serialize(result));
        }

        private string Post(string path, string body)
        {
            return Send("POST", path, body);
        }

        private string Send(string method, string path, string body)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(_serverUrl + path);
            request.Method = method;
            request.Accept = "application/json";
            request.Timeout = 10000;

            if (!String.IsNullOrEmpty(_agentToken))
                request.Headers["x-agent-token"] = _agentToken;

            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                request.ContentType = "application/json";
                request.ContentLength = bytes.Length;
                using (Stream stream = request.GetRequestStream())
                    stream.Write(bytes, 0, bytes.Length);
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return reader.ReadToEnd();
        }
    }
}
