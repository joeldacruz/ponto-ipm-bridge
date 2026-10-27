using System;
using System.Net.Sockets;
using System.Threading;

namespace PontoCamara.TopdataAgent
{
    public sealed class TopdataDeviceClient
    {
        private readonly string _host;
        private readonly int _port;

        public TopdataDeviceClient(string host, int port)
        {
            _host = host;
            _port = port;
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
            // Segurança: enquanto a DLL oficial SDK_Inner_Rep não estiver integrada,
            // nenhuma tarefa de escrita no REP pode ser marcada como sucesso.
            return new JobResult
            {
                ok = false,
                error = "SDK_TOPDATA_NOT_CONNECTED"
            };
        }
    }
}
