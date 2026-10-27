using System;
using System.Configuration;
using System.Threading;

namespace PontoCamara.TopdataAgent
{
    internal static class Program
    {
        private static AgentSettings ReadSettings()
        {
            AgentSettings s = new AgentSettings();
            s.ServerUrl = ConfigurationManager.AppSettings["ServerUrl"] ?? "http://127.0.0.1:3090";
            s.AgentId = ConfigurationManager.AppSettings["AgentId"] ?? "topdata-windows-01";
            s.AgentToken = ConfigurationManager.AppSettings["AgentToken"] ?? "";
            s.DeviceId = ConfigurationManager.AppSettings["DeviceId"] ?? "rep-topdata-02";
            s.DeviceHost = ConfigurationManager.AppSettings["DeviceHost"] ?? "10.20.20.222";
            s.DevicePort = Int32.Parse(ConfigurationManager.AppSettings["DevicePort"] ?? "51000");
            s.LoopSeconds = Int32.Parse(ConfigurationManager.AppSettings["LoopSeconds"] ?? "30");
            return s;
        }

        private static void Main(string[] args)
        {
            AgentSettings settings = ReadSettings();
            ApiClient api = new ApiClient(settings.ServerUrl, settings.AgentToken);
            TopdataDeviceClient device = new TopdataDeviceClient(settings.DeviceHost, settings.DevicePort);

            Console.WriteLine("Ponto Camara - Agente Topdata");
            Console.WriteLine("REP: {0}:{1}", settings.DeviceHost, settings.DevicePort);
            Console.WriteLine("Servidor: {0}", settings.ServerUrl);
            Console.WriteLine("Modo seguro: escrita no REP bloqueada ate integrar SDK oficial.");

            while (true)
            {
                try
                {
                    bool online = device.IsReachable();
                    api.SendHeartbeat(settings.AgentId, settings.DeviceId, online);
                    Console.WriteLine("[{0}] REP {1}", DateTime.Now, online ? "ONLINE" : "OFFLINE");

                    if (online)
                    {
                        SyncJob[] jobs = api.GetJobs(settings.AgentId);
                        int i;
                        for (i = 0; i < jobs.Length; i++)
                        {
                            SyncJob job = jobs[i];
                            JobResult result = device.Execute(job);
                            api.CompleteJob(job.id, result.ok, result.error);
                            Console.WriteLine("Job {0}: {1}", job.id, result.ok ? "OK" : result.error);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[{0}] ERRO: {1}", DateTime.Now, ex.Message);
                }

                Thread.Sleep(TimeSpan.FromSeconds(settings.LoopSeconds));
            }
        }
    }
}
