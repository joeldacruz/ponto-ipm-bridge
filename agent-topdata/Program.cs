using System;
using System.Configuration;
using System.IO;
using System.Threading;

namespace PontoCamara.TopdataAgent
{
    internal static class Program
    {
        private static AgentSettings ReadSettings()
        {
            AgentSettings s = new AgentSettings();
            s.ServerUrl = Environment.GetEnvironmentVariable("PONTO_SERVER_URL")
                ?? ConfigurationManager.AppSettings["ServerUrl"]
                ?? "http://127.0.0.1:3090";
            s.AgentId = Environment.GetEnvironmentVariable("PONTO_AGENT_ID")
                ?? ConfigurationManager.AppSettings["AgentId"]
                ?? "topdata-windows-01";
            s.AgentToken = Environment.GetEnvironmentVariable("PONTO_AGENT_TOKEN")
                ?? ConfigurationManager.AppSettings["AgentToken"]
                ?? "";
            s.DeviceId = Environment.GetEnvironmentVariable("PONTO_DEVICE_ID")
                ?? ConfigurationManager.AppSettings["DeviceId"]
                ?? "rep-topdata-02";
            s.DeviceHost = Environment.GetEnvironmentVariable("TOPDATA_HOST")
                ?? ConfigurationManager.AppSettings["DeviceHost"]
                ?? "10.20.20.222";
            s.DevicePort = Int32.Parse(
                Environment.GetEnvironmentVariable("TOPDATA_PORT")
                ?? ConfigurationManager.AppSettings["DevicePort"]
                ?? "51000");
            s.LoopSeconds = Int32.Parse(
                Environment.GetEnvironmentVariable("TOPDATA_LOOP_SECONDS")
                ?? ConfigurationManager.AppSettings["LoopSeconds"]
                ?? "30");
            return s;
        }

        private static void CollectAttendance(
            ApiClient api,
            TopdataSdkReader reader,
            string deviceId,
            string checkpointFile,
            int initialNsr)
        {
            bool hasCheckpoint = File.Exists(checkpointFile);
            int checkpoint = initialNsr;

            if (hasCheckpoint)
            {
                string value = File.ReadAllText(checkpointFile).Trim();
                if (value.Length > 0)
                    checkpoint = Int32.Parse(value);
            }

            TopdataReadResult probe = reader.ReadNsr(checkpoint);
            TopdataEvent probeEvent = TopdataAfdParser.ParseAttendance(deviceId, probe.rawLine);

            if (!hasCheckpoint)
            {
                api.SendEvents(deviceId, new TopdataEvent[] { probeEvent });
                File.WriteAllText(checkpointFile, checkpoint.ToString());
                Console.WriteLine("NSR inicial importado: " + checkpoint);
            }

            int lastAvailable = checkpoint;
            if (!String.IsNullOrEmpty(probe.lastNsr))
                Int32.TryParse(probe.lastNsr, out lastAvailable);

            if (lastAvailable <= checkpoint)
                return;

            for (int nsr = checkpoint + 1; nsr <= lastAvailable; nsr++)
            {
                TopdataReadResult read = reader.ReadNsr(nsr);
                TopdataEvent evt = TopdataAfdParser.ParseAttendance(deviceId, read.rawLine);

                if (evt.nsr != nsr)
                    throw new InvalidOperationException("NSR retornado difere do solicitado.");

                api.SendEvents(deviceId, new TopdataEvent[] { evt });
                File.WriteAllText(checkpointFile, nsr.ToString());
                Console.WriteLine("NSR coletado: " + nsr);
            }
        }

        private static void Main(string[] args)
        {
            AgentSettings settings = ReadSettings();
            ApiClient api = new ApiClient(settings.ServerUrl, settings.AgentToken);
            TopdataDeviceClient device = new TopdataDeviceClient(settings.DeviceHost, settings.DevicePort);

            string sdkPath = Environment.GetEnvironmentVariable("TOPDATA_SDK_PATH");
            string communicationKey = Environment.GetEnvironmentVariable("TOPDATA_COMM_KEY");
            string initialNsrText = Environment.GetEnvironmentVariable("TOPDATA_INITIAL_NSR") ?? "43106";
            int initialNsr = Int32.Parse(initialNsrText);

            TopdataSdkReader reader = new TopdataSdkReader(
                settings.DeviceHost,
                communicationKey,
                sdkPath);

            string checkpointDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "PontoCamara");
            Directory.CreateDirectory(checkpointDir);
            string checkpointFile = Path.Combine(checkpointDir, settings.DeviceId + ".nsr");

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

                    if (online && reader.IsConfigured)
                    {
                        CollectAttendance(api, reader, settings.DeviceId, checkpointFile, initialNsr);
                    }
                    else if (online)
                    {
                        Console.WriteLine("Coleta SDK desativada: defina TOPDATA_SDK_PATH e TOPDATA_COMM_KEY.");
                    }

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
