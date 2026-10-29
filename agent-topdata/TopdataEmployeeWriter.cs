using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace PontoCamara.TopdataAgent
{
    internal sealed class TopdataEmployeeRecord
    {
        public string Name;
        public string Pis;
        public string Card;
        public string DisplayName;
        public string Pin;
        public bool VerifyBiometrics;
    }

    public sealed class TopdataEmployeeWriter
    {
        private readonly string _host;
        private readonly string _communicationKey;
        private readonly string _sdkPath;
        private readonly bool _writeEnabled;
        private readonly bool _allowAll;
        private readonly HashSet<string> _allowedPis = new HashSet<string>(StringComparer.Ordinal);
        private Assembly _assembly;
        private Type _sdkType;

        public TopdataEmployeeWriter(
            string host,
            string communicationKey,
            string sdkPath,
            bool writeEnabled,
            string allowedPis)
        {
            _host = host;
            _communicationKey = communicationKey;
            _sdkPath = sdkPath;
            _writeEnabled = writeEnabled;

            string raw = (allowedPis ?? "").Trim();
            _allowAll = raw == "*";

            if (!_allowAll && raw.Length > 0)
            {
                string[] parts = raw.Split(new char[] { ',', ';', ' ', '\t', '\r', '\n' },
                    StringSplitOptions.RemoveEmptyEntries);
                int i;
                for (i = 0; i < parts.Length; i++)
                {
                    string pis = NormalizePis(parts[i]);
                    if (pis != null)
                        _allowedPis.Add(pis);
                }
            }
        }

        public bool WriteEnabled
        {
            get { return _writeEnabled; }
        }

        public bool IsConfigured
        {
            get
            {
                return _writeEnabled
                    && !String.IsNullOrEmpty(_host)
                    && !String.IsNullOrEmpty(_communicationKey)
                    && !String.IsNullOrEmpty(_sdkPath)
                    && File.Exists(_sdkPath)
                    && (_allowAll || _allowedPis.Count > 0);
            }
        }

        public JobResult Execute(SyncJob job)
        {
            if (job == null || job.operation != "UPSERT_EMPLOYEE")
                return Fail("TOPDATA_UNSUPPORTED_JOB");

            if (!_writeEnabled)
                return Fail("TOPDATA_EMPLOYEE_WRITE_DISABLED");

            if (!IsConfigured)
                return Fail("SDK_TOPDATA_NOT_CONNECTED");

            if (job.payload == null || job.payload.employee == null || job.payload.binding == null)
                return Fail("TOPDATA_INVALID_JOB_PAYLOAD");

            if (!job.payload.employee.active || !job.payload.binding.enabled)
                return Fail("TOPDATA_EMPLOYEE_OR_BINDING_INACTIVE");

            string targetPis = NormalizePis(job.payload.binding.deviceEmployeeNo);
            if (targetPis == null)
                return Fail("TOPDATA_INVALID_PIS");

            if (!_allowAll && !_allowedPis.Contains(targetPis))
                return Fail("TOPDATA_WRITE_NOT_ALLOWED_FOR_EMPLOYEE");

            string targetPin = (job.payload.employee.pin ?? "").Trim();
            if (targetPin.Length != 4 || !IsDigits(targetPin))
                return Fail("TOPDATA_PIN_REQUIRED");

            try
            {
                EnsureSdkLoaded();

                object readSdk = NewSession();
                List<TopdataEmployeeRecord> current;
                try
                {
                    current = ReadEmployees(readSdk);
                }
                finally
                {
                    TryFinalizeRead(readSdk);
                }

                if (current.Count == 0)
                    return Fail("TOPDATA_EMPTY_REP_WRITE_BLOCKED");

                List<TopdataEmployeeRecord> desired = MergeTarget(current, job, targetPis, targetPin);
                SaveProtectedBackup(current, job.id);

                object writeSdk = NewSession();
                LoadEmployerIntoSession(writeSdk);
                TryFinalizeRead(writeSdk);
                BuildEmployeeList(writeSdk, desired);
                StartEmployeeOnlyWrite(writeSdk);

                string verifyError = VerifyDesiredState(desired, targetPis, targetPin);
                if (verifyError != null)
                    return Fail(verifyError);

                return new JobResult { ok = true, error = null };
            }
            catch (Exception ex)
            {
                return Fail("TOPDATA_WRITE_FAILED:" + SafeError(ex));
            }
        }

        private void EnsureSdkLoaded()
        {
            if (_assembly != null && _sdkType != null)
                return;

            string dir = Path.GetDirectoryName(_sdkPath);
            if (!String.IsNullOrEmpty(dir) && Directory.Exists(dir))
            {
                string[] dlls = Directory.GetFiles(dir, "*.dll");
                int i;
                for (i = 0; i < dlls.Length; i++)
                {
                    try { Assembly.LoadFrom(dlls[i]); }
                    catch { }
                }
            }

            _assembly = Assembly.LoadFrom(_sdkPath);
            _sdkType = _assembly.GetType("Sdk_Inner_Rep.InnerRepSdk", true);
        }

        private object NewSession()
        {
            object sdk = Activator.CreateInstance(_sdkType);

            int modelResult = Convert.ToInt32(
                _sdkType.GetMethod("DefineModeloRede", new Type[] { typeof(int) })
                    .Invoke(sdk, new object[] { 1 }));
            if (modelResult != 0)
                throw new InvalidOperationException("DEFINE_MODELO_REDE_" + modelResult);

            int commResult = Convert.ToInt32(
                _sdkType.GetMethod("DefineParametrosComunicacao", new Type[] { typeof(string), typeof(string) })
                    .Invoke(sdk, new object[] { _host, _communicationKey }));
            if (commResult != 0)
                throw new InvalidOperationException("DEFINE_COMUNICACAO_" + commResult);

            return sdk;
        }

        private List<TopdataEmployeeRecord> ReadEmployees(object sdk)
        {
            int requestResult = Convert.ToInt32(
                _sdkType.GetMethod("SolicitarDadosEmpregados").Invoke(sdk, null));
            if (requestResult != 0)
                throw new InvalidOperationException("SOLICITAR_EMPREGADOS_" + requestResult);

            Thread.Sleep(TimeSpan.FromSeconds(3));

            int quantity = 0;
            int previous = -1;
            int stable = 0;
            int attempt;
            for (attempt = 0; attempt < 20; attempt++)
            {
                quantity = Convert.ToInt32(
                    _sdkType.GetMethod("QuantidadeEmpregadosNoRep").Invoke(sdk, null));

                if (quantity > 0 && quantity == previous)
                    stable++;
                else
                    stable = 0;

                if (quantity > 0 && stable >= 2)
                    break;

                previous = quantity;
                Thread.Sleep(500);
            }

            if (quantity <= 0)
                throw new InvalidOperationException("REP_SEM_EMPREGADOS_OU_LEITURA_INCOMPLETA");

            ValidateNoUnsupportedEmployeeFeatures(sdk, quantity);

            List<TopdataEmployeeRecord> rows = new List<TopdataEmployeeRecord>();
            int i;
            for (i = 0; i < quantity; i++)
            {
                int readResult = Convert.ToInt32(
                    _sdkType.GetMethod("LeDadosEmpregados", new Type[] { typeof(int) })
                        .Invoke(sdk, new object[] { i }));

                if (readResult != 0)
                    throw new InvalidOperationException("LE_EMPREGADO_" + i + "_" + readResult);

                TopdataEmployeeRecord row = new TopdataEmployeeRecord();
                row.Name = ReadString(sdk, "LeNome");
                row.Pis = NormalizePis(ReadString(sdk, "LePis"));
                row.Card = NormalizeCard(ReadString(sdk, "LeCartao"));
                row.DisplayName = ReadString(sdk, "LeNomeExibicao");
                row.Pin = ReadString(sdk, "LeSenha");
                row.VerifyBiometrics = ParseSdkBoolean(ReadString(sdk, "LeVerificarBiometria"));

                ValidatePreserved(row, i);
                rows.Add(row);
            }

            return rows;
        }

        private void ValidateNoUnsupportedEmployeeFeatures(object sdk, int quantity)
        {
            FieldInfo field = _sdkType.GetField(
                "_arrEmpregadosSolicitados",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

            if (field == null)
                throw new InvalidOperationException("SDK_LISTA_ORIGINAL_NAO_LOCALIZADA");

            IList original = field.GetValue(sdk) as IList;
            if (original == null || original.Count != quantity)
                throw new InvalidOperationException("SDK_LISTA_ORIGINAL_INCOMPLETA");

            int i;
            for (i = 0; i < original.Count; i++)
            {
                object employee = original[i];
                if (employee == null)
                    throw new InvalidOperationException("SDK_EMPREGADO_ORIGINAL_NULO_" + i);

                Type type = employee.GetType();
                PropertyInfo bars = type.GetProperty("CartaoBarras");
                PropertyInfo prox = type.GetProperty("CartaoProx");
                PropertyInfo doubleCheck = type.GetProperty("DuplaVerificacao");

                ulong barsValue = bars == null ? 0UL : Convert.ToUInt64(bars.GetValue(employee, null));
                ulong proxValue = prox == null ? 0UL : Convert.ToUInt64(prox.GetValue(employee, null));
                bool doubleValue = doubleCheck != null && Convert.ToBoolean(doubleCheck.GetValue(employee, null));

                if (barsValue != 0UL || proxValue != 0UL || doubleValue)
                    throw new InvalidOperationException(
                        "EMPREGADO_EXISTENTE_USA_RECURSO_NAO_RECONSTRUIDO_" + i);
            }
        }

        private void ValidatePreserved(TopdataEmployeeRecord row, int index)
        {
            if (String.IsNullOrEmpty(row.Name))
                throw new InvalidOperationException("EMPREGADO_EXISTENTE_SEM_NOME_" + index);
            if (row.Pis == null)
                throw new InvalidOperationException("EMPREGADO_EXISTENTE_PIS_INVALIDO_" + index);
            if (String.IsNullOrEmpty(row.Card))
                throw new InvalidOperationException("EMPREGADO_EXISTENTE_CARTAO_INVALIDO_" + index);
            if (!String.IsNullOrEmpty(row.Pin) && (row.Pin.Length != 4 || !IsDigits(row.Pin)))
                throw new InvalidOperationException("EMPREGADO_EXISTENTE_PIN_INVALIDO_" + index);
            if (String.IsNullOrEmpty(row.DisplayName))
                row.DisplayName = row.Name;
        }

        private List<TopdataEmployeeRecord> MergeTarget(
            List<TopdataEmployeeRecord> current,
            SyncJob job,
            string targetPis,
            string targetPin)
        {
            int targetIndex = -1;
            int i;

            for (i = 0; i < current.Count; i++)
            {
                if (current[i].Pis == targetPis)
                {
                    if (targetIndex >= 0)
                        throw new InvalidOperationException("PIS_DUPLICADO_NO_REP");
                    targetIndex = i;
                }
            }

            TopdataEmployeeRecord existing = targetIndex >= 0 ? current[targetIndex] : null;
            string explicitCard = NormalizeCard(job.payload.binding.cardNo);
            string targetCard = explicitCard;

            if (String.IsNullOrEmpty(targetCard) && existing != null)
                targetCard = existing.Card;

            if (String.IsNullOrEmpty(targetCard))
                targetCard = CardFromRegistration(job.payload.employee.registration);

            if (String.IsNullOrEmpty(targetCard))
                throw new InvalidOperationException("CARTAO_NAO_DEFINIDO");

            for (i = 0; i < current.Count; i++)
            {
                if (i != targetIndex && current[i].Card == targetCard)
                    throw new InvalidOperationException("CARTAO_JA_USADO_POR_OUTRO_EMPREGADO");
            }

            string name = (job.payload.employee.name ?? "").Trim();
            if (name.Length == 0)
                throw new InvalidOperationException("NOME_VAZIO");

            TopdataEmployeeRecord target = new TopdataEmployeeRecord();
            target.Name = name;
            target.Pis = targetPis;
            target.Card = targetCard;
            target.DisplayName = name;
            target.Pin = targetPin;
            target.VerifyBiometrics = existing != null && existing.VerifyBiometrics;

            List<TopdataEmployeeRecord> desired = new List<TopdataEmployeeRecord>();
            for (i = 0; i < current.Count; i++)
                desired.Add(i == targetIndex ? target : current[i]);

            if (targetIndex < 0)
                desired.Add(target);

            Dictionary<string, bool> seenPis = new Dictionary<string, bool>(StringComparer.Ordinal);
            Dictionary<string, bool> seenCard = new Dictionary<string, bool>(StringComparer.Ordinal);
            for (i = 0; i < desired.Count; i++)
            {
                TopdataEmployeeRecord row = desired[i];
                if (seenPis.ContainsKey(row.Pis))
                    throw new InvalidOperationException("PIS_DUPLICADO_NA_LISTA_FINAL");
                if (seenCard.ContainsKey(row.Card))
                    throw new InvalidOperationException("CARTAO_DUPLICADO_NA_LISTA_FINAL");
                seenPis.Add(row.Pis, true);
                seenCard.Add(row.Card, true);
            }

            return desired;
        }

        private void LoadEmployerIntoSession(object sdk)
        {
            int result = Convert.ToInt32(
                _sdkType.GetMethod("SolicitarDadosEmpregador").Invoke(sdk, null));
            if (result != 0)
                throw new InvalidOperationException("SOLICITAR_EMPREGADOR_" + result);

            Thread.Sleep(TimeSpan.FromSeconds(5));

            MethodInfo statusMethod = _sdkType.GetMethod("RecebeStatusLeitura");
            MethodInfo resultMethod = _sdkType.GetMethod("RecebeResultadoLeitura");
            if (statusMethod != null && Convert.ToInt32(statusMethod.Invoke(sdk, null)) != 0)
                throw new InvalidOperationException("LEITURA_EMPREGADOR_STATUS");
            if (resultMethod != null && Convert.ToInt32(resultMethod.Invoke(sdk, null)) != 0)
                throw new InvalidOperationException("LEITURA_EMPREGADOR_RESULTADO");
        }

        private void BuildEmployeeList(object sdk, List<TopdataEmployeeRecord> desired)
        {
            _sdkType.GetMethod("LimpaListaEmpregados").Invoke(sdk, null);

            MethodInfo include = _sdkType.GetMethod(
                "IncluiEmpregadoLista",
                new Type[] {
                    typeof(string), typeof(string), typeof(string), typeof(string),
                    typeof(bool), typeof(string), typeof(bool)
                });

            int i;
            for (i = 0; i < desired.Count; i++)
            {
                TopdataEmployeeRecord row = desired[i];
                bool keyboard = !String.IsNullOrEmpty(row.Pin);
                int result = Convert.ToInt32(include.Invoke(
                    sdk,
                    new object[] {
                        row.Name,
                        row.Pis,
                        row.Card,
                        row.DisplayName,
                        keyboard,
                        row.Pin ?? "",
                        row.VerifyBiometrics
                    }));

                if (result != 0)
                    throw new InvalidOperationException("INCLUI_EMPREGADO_LISTA_" + i + "_" + result);
            }
        }

        private void StartEmployeeOnlyWrite(object sdk)
        {
            BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            object employeeList = _sdkType.GetField("_listaEmpregados", flags).GetValue(sdk);
            object employer = _sdkType.GetField("_empregador", flags).GetValue(sdk);

            if (employeeList == null || employer == null)
                throw new InvalidOperationException("SDK_LISTA_OU_EMPREGADOR_NAO_DISPONIVEL");

            Type repType = FindLoadedType("TopData.GerenciadorRep.Bi.Dominio.RepBio");
            Type managerType = FindLoadedType("TopData.GerenciadorRep.Bi.Dominio.GerenciadorConfigEmpregados");
            if (repType == null || managerType == null)
                throw new InvalidOperationException("SDK_TIPOS_INTERNOS_NAO_LOCALIZADOS");

            string local = Convert.ToString(GetOptionalField(sdk, "_local"));
            if (String.IsNullOrEmpty(local))
                local = Convert.ToString(GetOptionalField(sdk, "_Local"));

            object[] repArgs = new object[] {
                Convert.ToString(GetRequiredField(sdk, "_ipAddress")),
                Convert.ToInt32(GetRequiredField(sdk, "_port")),
                Convert.ToUInt16(GetRequiredField(sdk, "_repId")),
                Convert.ToString(GetRequiredField(sdk, "_chaveComunicacao")),
                employer,
                local ?? "",
                Convert.ToString(GetRequiredField(sdk, "_senhaRelogio")),
                Convert.ToString(GetRequiredField(sdk, "_senhaComunic")),
                Convert.ToString(GetRequiredField(sdk, "_senhaBio")),
                Convert.ToBoolean(GetRequiredField(sdk, "_repClient")),
                Convert.ToInt32(GetRequiredField(sdk, "_portaServidor")),
                Convert.ToInt32(GetRequiredField(sdk, "_tempoespera")),
                Convert.ToInt32(GetRequiredField(sdk, "_tempoEsperaConexao"))
            };

            ConstructorInfo repCtor = null;
            ConstructorInfo[] ctors = repType.GetConstructors(flags);
            int i;
            for (i = 0; i < ctors.Length; i++)
            {
                ParameterInfo[] p = ctors[i].GetParameters();
                if (p.Length == 13
                    && p[0].ParameterType == typeof(string)
                    && p[1].ParameterType == typeof(int)
                    && p[2].ParameterType == typeof(ushort)
                    && p[3].ParameterType == typeof(string)
                    && p[4].ParameterType.IsInstanceOfType(employer)
                    && p[9].ParameterType == typeof(bool)
                    && p[10].ParameterType == typeof(int)
                    && p[11].ParameterType == typeof(int)
                    && p[12].ParameterType == typeof(int))
                {
                    repCtor = ctors[i];
                    break;
                }
            }

            if (repCtor == null)
                throw new InvalidOperationException("REP_BIO_CONSTRUTOR_NAO_LOCALIZADO");

            object rep = repCtor.Invoke(repArgs);

            MethodInfo factory = null;
            MethodInfo[] methods = managerType.GetMethods(
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            for (i = 0; i < methods.Length; i++)
            {
                if (methods[i].Name != "getInstance")
                    continue;
                ParameterInfo[] p = methods[i].GetParameters();
                if (p.Length == 2
                    && p[0].ParameterType.IsInstanceOfType(rep)
                    && p[1].ParameterType.IsInstanceOfType(employeeList))
                {
                    factory = methods[i];
                    break;
                }
            }

            if (factory == null)
                throw new InvalidOperationException("GERENCIADOR_EMPREGADOS_FACTORY_NAO_LOCALIZADO");

            object manager = factory.Invoke(null, new object[] { rep, employeeList });
            if (manager == null)
                throw new InvalidOperationException("GERENCIADOR_EMPREGADOS_NAO_CRIADO");

            PropertyInfo chamadaSdk = manager.GetType().GetProperty("ChamadaSDK", flags);
            if (chamadaSdk != null && chamadaSdk.CanWrite)
            {
                chamadaSdk.SetValue(manager, true, null);
            }
            else
            {
                MethodInfo setChamadaSdk = manager.GetType().GetMethod("set_ChamadaSDK", flags);
                if (setChamadaSdk != null)
                    setChamadaSdk.Invoke(manager, new object[] { true });
            }

            MethodInfo start = manager.GetType().GetMethod("IniciarProcesso", flags);
            if (start == null)
                throw new InvalidOperationException("GERENCIADOR_EMPREGADOS_SEM_INICIAR");

            start.Invoke(manager, null);

            // O SDK executa a escrita de forma assíncrona. A confirmação real é feita
            // por leitura integral do REP em uma nova sessão, nunca pelo simples retorno.
            Thread.Sleep(TimeSpan.FromSeconds(5));
        }

        private string VerifyDesiredState(
            List<TopdataEmployeeRecord> desired,
            string targetPis,
            string targetPin)
        {
            Exception lastError = null;
            int attempt;

            for (attempt = 0; attempt < 4; attempt++)
            {
                object verifySdk = null;
                try
                {
                    verifySdk = NewSession();
                    List<TopdataEmployeeRecord> actual = ReadEmployees(verifySdk);

                    if (SameEmployeeSet(desired, actual))
                    {
                        TopdataEmployeeRecord target = FindByPis(actual, targetPis);
                        if (target != null && target.Pin == targetPin)
                            return null;
                    }
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
                finally
                {
                    if (verifySdk != null)
                        TryFinalizeRead(verifySdk);
                }

                Thread.Sleep(TimeSpan.FromSeconds(5));
            }

            return lastError == null
                ? "TOPDATA_VERIFY_MISMATCH"
                : "TOPDATA_VERIFY_FAILED:" + SafeError(lastError);
        }

        private static bool SameEmployeeSet(
            List<TopdataEmployeeRecord> expected,
            List<TopdataEmployeeRecord> actual)
        {
            if (expected.Count != actual.Count)
                return false;

            Dictionary<string, TopdataEmployeeRecord> map =
                new Dictionary<string, TopdataEmployeeRecord>(StringComparer.Ordinal);

            int i;
            for (i = 0; i < actual.Count; i++)
            {
                if (map.ContainsKey(actual[i].Pis))
                    return false;
                map.Add(actual[i].Pis, actual[i]);
            }

            for (i = 0; i < expected.Count; i++)
            {
                TopdataEmployeeRecord a;
                TopdataEmployeeRecord e = expected[i];
                if (!map.TryGetValue(e.Pis, out a))
                    return false;
                if (e.Name != a.Name
                    || e.Card != a.Card
                    || e.DisplayName != a.DisplayName
                    || (e.Pin ?? "") != (a.Pin ?? "")
                    || e.VerifyBiometrics != a.VerifyBiometrics)
                    return false;
            }

            return true;
        }

        private static TopdataEmployeeRecord FindByPis(
            List<TopdataEmployeeRecord> rows,
            string pis)
        {
            int i;
            for (i = 0; i < rows.Count; i++)
                if (rows[i].Pis == pis)
                    return rows[i];
            return null;
        }

        private void SaveProtectedBackup(List<TopdataEmployeeRecord> current, int jobId)
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "PontoCamara",
                "backups");
            Directory.CreateDirectory(dir);

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("PONTO-CAMARA TOPDATA EMPLOYEES BACKUP");
            sb.AppendLine("UTC=" + DateTime.UtcNow.ToString("o"));
            sb.AppendLine("JOB=" + jobId);
            sb.AppendLine("NAME\tPIS\tCARD\tDISPLAY\tPIN\tBIO");

            int i;
            for (i = 0; i < current.Count; i++)
            {
                TopdataEmployeeRecord row = current[i];
                sb.Append(EscapeBackup(row.Name)).Append("\t")
                  .Append(EscapeBackup(row.Pis)).Append("\t")
                  .Append(EscapeBackup(row.Card)).Append("\t")
                  .Append(EscapeBackup(row.DisplayName)).Append("\t")
                  .Append(EscapeBackup(row.Pin)).Append("\t")
                  .Append(row.VerifyBiometrics ? "1" : "0").AppendLine();
            }

            byte[] plain = Encoding.UTF8.GetBytes(sb.ToString());
            byte[] protectedBytes = ProtectedData.Protect(
                plain,
                null,
                DataProtectionScope.LocalMachine);

            string file = Path.Combine(
                dir,
                "employees-before-write-" + DateTime.Now.ToString("yyyyMMdd-HHmmss")
                    + "-job" + jobId + ".dpapi");
            File.WriteAllBytes(file, protectedBytes);
        }

        private static string EscapeBackup(string value)
        {
            return (value ?? "")
                .Replace("\\", "\\\\")
                .Replace("\t", "\\t")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }

        private Type FindLoadedType(string fullName)
        {
            Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
            int i;
            for (i = 0; i < assemblies.Length; i++)
            {
                Type type = assemblies[i].GetType(fullName, false);
                if (type != null)
                    return type;
            }
            return null;
        }

        private object GetRequiredField(object sdk, string name)
        {
            object value = GetOptionalField(sdk, name);
            if (value == null)
                throw new InvalidOperationException("SDK_CAMPO_AUSENTE_" + name);
            return value;
        }

        private object GetOptionalField(object sdk, string name)
        {
            FieldInfo field = _sdkType.GetField(
                name,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return field == null ? null : field.GetValue(sdk);
        }

        private string ReadString(object sdk, string methodName)
        {
            MethodInfo method = _sdkType.GetMethod(methodName);
            if (method == null)
                throw new InvalidOperationException("SDK_METODO_AUSENTE_" + methodName);
            object value = method.Invoke(sdk, null);
            return value == null ? "" : Convert.ToString(value).Trim();
        }

        private void TryFinalizeRead(object sdk)
        {
            try
            {
                MethodInfo method = _sdkType.GetMethod("FinalizaLeitura");
                if (method != null)
                    method.Invoke(sdk, null);
            }
            catch { }
        }

        private static string NormalizePis(string value)
        {
            string digits = DigitsOnly(value);
            if (digits.Length == 12 && digits[0] == '0')
                digits = digits.Substring(1);
            return digits.Length == 11 ? digits : null;
        }

        private static string NormalizeCard(string value)
        {
            string digits = DigitsOnly(value);
            if (digits.Length == 0)
                return null;

            int first = 0;
            while (first < digits.Length - 1 && digits[first] == '0')
                first++;
            return digits.Substring(first);
        }

        private static string CardFromRegistration(string registration)
        {
            string value = (registration ?? "").Trim();
            if (value.Length == 0)
                return null;

            int hyphen = value.IndexOf('-');
            if (hyphen > 0)
                value = value.Substring(0, hyphen);

            return NormalizeCard(value);
        }

        private static string DigitsOnly(string value)
        {
            if (String.IsNullOrEmpty(value))
                return "";

            StringBuilder sb = new StringBuilder();
            int i;
            for (i = 0; i < value.Length; i++)
                if (Char.IsDigit(value[i]))
                    sb.Append(value[i]);
            return sb.ToString();
        }

        private static bool IsDigits(string value)
        {
            if (String.IsNullOrEmpty(value))
                return false;
            int i;
            for (i = 0; i < value.Length; i++)
                if (!Char.IsDigit(value[i]))
                    return false;
            return true;
        }

        private static bool ParseSdkBoolean(string value)
        {
            string v = (value ?? "").Trim().ToLowerInvariant();
            return v == "1" || v == "true" || v == "sim" || v == "yes";
        }

        private static JobResult Fail(string error)
        {
            return new JobResult { ok = false, error = error };
        }

        private static string SafeError(Exception ex)
        {
            Exception current = ex;
            while (current is TargetInvocationException && current.InnerException != null)
                current = current.InnerException;

            string message = current.Message ?? current.GetType().Name;
            message = message.Replace("\r", " ").Replace("\n", " ").Trim();
            if (message.Length > 180)
                message = message.Substring(0, 180);
            return message;
        }
    }
}
