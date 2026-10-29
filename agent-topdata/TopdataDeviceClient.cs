using System;
using System.Net.Sockets;
using System.Threading;

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
            TcpClient client = new TcpClient();
            try
            {
                IAsyncResult ar = client.BeginConnect(_host, _port, null, null);
                WaitHandle wait = ar.AsyncWaitHandle;
                try
                {
                    if (!wait.WaitOne(TimeSpan.FromSeconds(3), false))
                        return false;
                    client.EndConnect(ar);
                    return client.Connected;
                }
                finally
                {
                    wait.Close();
                }
            }
            catch
            {
                return false;
            }
            finally
            {
                client.Close();
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
