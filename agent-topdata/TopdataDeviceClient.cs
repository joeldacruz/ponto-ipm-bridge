using System;
using System.Net.NetworkInformation;

namespace PontoCamara.TopdataAgent
{
    public sealed class TopdataDeviceClient
    {
        private readonly string _host;
        private readonly int _port;
        private readonly TopdataEmployeeWriter _employeeWriter;

        public TopdataDeviceClient(string host, int port, TopdataEmployeeWriter employeeWriter)
        {
            _host = host;
            _port = port;
            _employeeWriter = employeeWriter;
        }

        public bool IsReachable()
        {
            // Nao abra uma conexao TCP de sondagem na porta 51000.
            // O SDK Topdata usa essa porta e alguns REPs aceitam uma unica
            // sessao por vez; sondagens frequentes podem concorrer com o SDK
            // e deixar muitas conexoes em FIN_WAIT_2.
            try
            {
                using (Ping ping = new Ping())
                {
                    PingReply reply = ping.Send(_host, 1000);
                    return reply != null && reply.Status == IPStatus.Success;
                }
            }
            catch
            {
                return false;
            }
        }

        public JobResult Execute(SyncJob job)
        {
            if (_employeeWriter == null)
                return new JobResult { ok = false, error = "SDK_TOPDATA_NOT_CONNECTED" };

            return _employeeWriter.Execute(job);
        }
    }
}
