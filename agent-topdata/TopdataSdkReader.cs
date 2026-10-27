using System;
using System.IO;
using System.Reflection;
using System.Threading;

namespace PontoCamara.TopdataAgent
{
    public sealed class TopdataSdkReader
    {
        private readonly string _host;
        private readonly string _communicationKey;
        private readonly string _sdkPath;
        private Assembly _assembly;
        private Type _sdkType;

        public TopdataSdkReader(string host, string communicationKey, string sdkPath)
        {
            _host = host;
            _communicationKey = communicationKey;
            _sdkPath = sdkPath;
        }

        public bool IsConfigured
        {
            get
            {
                return !String.IsNullOrEmpty(_communicationKey)
                    && !String.IsNullOrEmpty(_sdkPath)
                    && File.Exists(_sdkPath);
            }
        }

        private void EnsureLoaded()
        {
            if (_sdkType != null)
                return;

            _assembly = Assembly.LoadFrom(_sdkPath);
            _sdkType = _assembly.GetType("Sdk_Inner_Rep.InnerRepSdk", true);
        }

        private object NewSession()
        {
            EnsureLoaded();
            object sdk = Activator.CreateInstance(_sdkType);

            int modelResult = Convert.ToInt32(Invoke(sdk, "DefineModeloRede", new object[] { 1 }));
            if (modelResult != 0)
                throw new InvalidOperationException("DefineModeloRede falhou: " + modelResult);

            int parametersResult = Convert.ToInt32(
                Invoke(sdk, "DefineParametrosComunicacao", new object[] { _host, _communicationKey }));

            if (parametersResult != 0)
                throw new InvalidOperationException("DefineParametrosComunicacao falhou: " + parametersResult);

            return sdk;
        }

        private object Invoke(object target, string name, object[] args)
        {
            return _sdkType.InvokeMember(
                name,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.InvokeMethod,
                null,
                target,
                args);
        }

        public TopdataReadResult ReadNsr(int nsr)
        {
            object sdk = NewSession();
            try
            {
                int request = Convert.ToInt32(Invoke(sdk, "SolicitaRegistroDoNsr", new object[] { nsr }));
                if (request != 0)
                    throw new InvalidOperationException("SolicitaRegistroDoNsr falhou: " + request);

                DateTime deadline = DateTime.UtcNow.AddSeconds(30);
                int status = Convert.ToInt32(Invoke(sdk, "RecebeStatusLeitura", new object[0]));

                while (status < 2 && DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(20);
                    status = Convert.ToInt32(Invoke(sdk, "RecebeStatusLeitura", new object[0]));
                }

                if (status < 2)
                    throw new TimeoutException("Timeout aguardando leitura do REP.");

                string serial = Convert.ToString(Invoke(sdk, "LeNumeroSerialDoInnerRep", new object[0]));
                string lastNsr = Convert.ToString(Invoke(sdk, "LeNumeroDoUltimoNsrDoInnerRep", new object[0]));
                int resultCode = Convert.ToInt32(Invoke(sdk, "RecebeResultadoLeitura", new object[0]));
                string rawLine = Convert.ToString(Invoke(sdk, "LeLinhaDoRegistro", new object[0]));

                return new TopdataReadResult
                {
                    serial = serial,
                    lastNsr = lastNsr,
                    resultCode = resultCode,
                    rawLine = rawLine
                };
            }
            finally
            {
                try { Invoke(sdk, "FinalizaLeitura", new object[0]); }
                catch { }
            }
        }
    }

    public sealed class TopdataReadResult
    {
        public string serial;
        public string lastNsr;
        public int resultCode;
        public string rawLine;
    }
}
