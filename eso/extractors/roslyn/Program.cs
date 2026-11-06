using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Eso.Extractors.Roslyn;

public static class Program
{
    public static int Main(string[] args)
    {
        string? project = null;
        string? buildId = null;
        string? solutionPath = null;
        string? consumerRoot = null;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--project" && i + 1 < args.Length) project = args[++i];
            else if (args[i] == "--build-id" && i + 1 < args.Length) buildId = args[++i];
            else if (args[i] == "--solution" && i + 1 < args.Length) solutionPath = args[++i];
            else if (args[i] == "--consumer-root" && i + 1 < args.Length) consumerRoot = args[++i];
        }

        if (string.IsNullOrWhiteSpace(project) || string.IsNullOrWhiteSpace(solutionPath))
        {
            var err = new
            {
                error = "TOOLCHAIN_UNAVAILABLE",
                status = "OUT",
                message = "Missing required --project or --solution argument"
            };
            Console.WriteLine(JsonSerializer.Serialize(err));
            return 2;
        }

        buildId ??= "default";

        // Resolve absolute solution/project path
        string fullSolutionPath = Path.GetFullPath(solutionPath);
        if (!File.Exists(fullSolutionPath) && !Directory.Exists(fullSolutionPath))
        {
            var err = new
            {
                error = "TOOLCHAIN_UNAVAILABLE",
                status = "OUT",
                message = $"Solution or project not found: {solutionPath}"
            };
            Console.WriteLine(JsonSerializer.Serialize(err));
            return 2;
        }

        string baseDir = File.Exists(fullSolutionPath) ? Path.GetDirectoryName(fullSolutionPath)! : fullSolutionPath;

        // Collect .cs files excluding bin/obj/.git
        var csFiles = Directory.GetFiles(baseDir, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                     && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                     && !f.Contains($"{Path.DirectorySeparatorChar}.git{Path.DirectorySeparatorChar}"))
            .OrderBy(f => f)
            .ToList();

        if (csFiles.Count == 0)
        {
            var err = new
            {
                error = "TOOLCHAIN_UNAVAILABLE",
                status = "UNKNOWN",
                message = $"No C# source files found in {baseDir}"
            };
            Console.WriteLine(JsonSerializer.Serialize(err));
            return 2;
        }

        var failedFiles = new List<object>();
        var validTrees = new List<(string RelPath, SyntaxTree Tree)>();

        foreach (var file in csFiles)
        {
            string relPath = Path.GetRelativePath(baseDir, file).Replace('\\', '/');
            try
            {
                string sourceText = File.ReadAllText(file, Encoding.UTF8);
                var tree = CSharpSyntaxTree.ParseText(sourceText, path: relPath, encoding: Encoding.UTF8);
                var diags = tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();

                if (diags.Any())
                {
                    failedFiles.Add(new
                    {
                        path = relPath,
                        error = "PARSE_FAILED",
                        message = string.Join("; ", diags.Take(3).Select(d => d.GetMessage()))
                    });
                }
                else
                {
                    validTrees.Add((relPath, tree));
                }
            }
            catch (Exception ex)
            {
                failedFiles.Add(new
                {
                    path = relPath,
                    error = "PARSE_FAILED",
                    message = ex.Message
                });
            }
        }

        var nodes = new List<NodeRecord>();
        var edges = new List<EdgeRecord>();
        var sourceClaims = new List<ClaimRecord>();

        var nodeMap = new Dictionary<string, NodeRecord>(); // node_id -> record
        var keyToId = new Dictionary<string, string>();     // $"{kind}:{node_key}" -> node_id

        // Create compilation for valid trees
        var mscorlib = MetadataReference.CreateFromFile(typeof(object).Assembly.Location);
        var compilation = CSharpCompilation.Create("MonolithAnalysis", validTrees.Select(vt => vt.Tree), new[] { mscorlib });

        foreach (var (relPath, tree) in validTrees)
        {
            var root = tree.GetRoot();
            var model = compilation.GetSemanticModel(tree);

            // 1. Module / File node
            string fileName = Path.GetFileName(relPath);
            string fileNodeId = MakeNodeId(project, "module", relPath, fileName);
            AddNode(nodes, nodeMap, keyToId, new NodeRecord
            {
                node_id = fileNodeId,
                project = project,
                build_id = buildId,
                kind = "module",
                node_key = fileName,
                path = relPath
            });

            // 2. Namespaces
            var nsDeclarations = root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>();
            foreach (var ns in nsDeclarations)
            {
                string nsName = ns.Name.ToString();
                string nsNodeId = MakeNodeId(project, "namespace", relPath, nsName);
                AddNode(nodes, nodeMap, keyToId, new NodeRecord
                {
                    node_id = nsNodeId,
                    project = project,
                    build_id = buildId,
                    kind = "namespace",
                    node_key = nsName,
                    path = relPath
                });

                // File defines namespace
                AddEdgeWithClaim(edges, sourceClaims, project, buildId, fileNodeId, nsNodeId, "defines", $"{fileName} defines namespace {nsName}");
            }

            // 3. Classes / Interfaces / Structs / Records
            var typeDeclarations = root.DescendantNodes().OfType<TypeDeclarationSyntax>();
            foreach (var typeDecl in typeDeclarations)
            {
                var typeSymbol = model.GetDeclaredSymbol(typeDecl);
                string fqn = typeSymbol?.ToDisplayString() ?? typeDecl.Identifier.Text;
                string typeName = typeDecl.Identifier.Text;

                string kind = DetermineKind(typeName, relPath, typeDecl);
                string typeNodeId = MakeNodeId(project, kind, relPath, fqn);

                AddNode(nodes, nodeMap, keyToId, new NodeRecord
                {
                    node_id = typeNodeId,
                    project = project,
                    build_id = buildId,
                    kind = kind,
                    node_key = fqn,
                    path = relPath
                });

                // Find parent namespace or file
                var parentNs = typeDecl.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault();
                string parentNodeId = parentNs != null
                    ? MakeNodeId(project, "namespace", relPath, parentNs.Name.ToString())
                    : fileNodeId;

                AddEdgeWithClaim(edges, sourceClaims, project, buildId, parentNodeId, typeNodeId, "defines", $"{parentNodeId} defines {fqn}");

                // Check table mapping for entities
                if (kind == "entity")
                {
                    string tableName = typeName.EndsWith("s") ? typeName : typeName + "s";
                    string tableNodeId = MakeNodeId(project, "table", relPath, tableName);
                    AddNode(nodes, nodeMap, keyToId, new NodeRecord
                    {
                        node_id = tableNodeId,
                        project = project,
                        build_id = buildId,
                        kind = "table",
                        node_key = tableName,
                        path = relPath
                    });
                    AddEdgeWithClaim(edges, sourceClaims, project, buildId, typeNodeId, tableNodeId, "maps_to", $"{fqn} maps to table {tableName}");
                }

                // 4. Methods
                var methodDeclarations = typeDecl.Members.OfType<BaseMethodDeclarationSyntax>();
                foreach (var method in methodDeclarations)
                {
                    string methodName = method is MethodDeclarationSyntax m ? m.Identifier.Text : ".ctor";
                    string methodFqn = $"{fqn}.{methodName}";
                    string methodNodeId = MakeNodeId(project, "method", relPath, methodFqn);

                    AddNode(nodes, nodeMap, keyToId, new NodeRecord
                    {
                        node_id = methodNodeId,
                        project = project,
                        build_id = buildId,
                        kind = "method",
                        node_key = methodFqn,
                        path = relPath
                    });

                    AddEdgeWithClaim(edges, sourceClaims, project, buildId, typeNodeId, methodNodeId, "defines", $"{fqn} defines {methodName}");

                    // Check invocations / references inside method body
                    var invocations = method.DescendantNodes().OfType<InvocationExpressionSyntax>();
                    foreach (var inv in invocations)
                    {
                        var symbol = model.GetSymbolInfo(inv).Symbol;
                        if (symbol != null)
                        {
                            string targetType = symbol.ContainingType?.ToDisplayString() ?? "";
                            string targetMethod = $"{targetType}.{symbol.Name}";
                            string targetMethodId = MakeNodeId(project, "method", relPath, targetMethod);

                            // If target node exists or can be referenced
                            if (nodeMap.ContainsKey(targetMethodId))
                            {
                                AddEdgeWithClaim(edges, sourceClaims, project, buildId, methodNodeId, targetMethodId, "references", $"{methodFqn} calls {targetMethod}");
                            }
                        }
                    }

                    // Check object creations
                    var creations = method.DescendantNodes().OfType<ObjectCreationExpressionSyntax>();
                    foreach (var creation in creations)
                    {
                        var createdType = model.GetTypeInfo(creation).Type;
                        if (createdType != null)
                        {
                            string targetFqn = createdType.ToDisplayString();
                            string targetTypeId = MakeNodeId(project, DetermineKind(createdType.Name, relPath, null), relPath, targetFqn);
                            if (nodeMap.ContainsKey(targetTypeId))
                            {
                                AddEdgeWithClaim(edges, sourceClaims, project, buildId, methodNodeId, targetTypeId, "depends_on", $"{methodFqn} creates {targetFqn}");
                            }
                        }
                    }
                }
            }
        }

        int totalFiles = validTrees.Count + failedFiles.Count;
        double fileCoverage = totalFiles > 0 ? (double)validTrees.Count / totalFiles : 0.0;
        fileCoverage = Math.Round(fileCoverage, 4);

        int classCount = nodes.Count(n => n.kind == "class" || n.kind == "entity" || n.kind == "dto");
        int methodCount = nodes.Count(n => n.kind == "method");

        bool isReady = failedFiles.Count == 0 && totalFiles > 0;
        string status = isReady ? "ready" : "unknown";

        var perKind = new Dictionary<string, double>
        {
            ["file"] = fileCoverage,
            ["class"] = isReady ? 1.0 : Math.Round(fileCoverage, 4),
            ["method"] = isReady ? 1.0 : Math.Round(fileCoverage, 4)
        };

        double completenessVal = perKind.Values.Min();

        var output = new
        {
            project = project,
            build_id = buildId,
            status = status,
            coverage = isReady ? 1.0 : fileCoverage,
            nodes = nodes,
            edges = edges,
            source_claims = sourceClaims,
            failed_files = failedFiles,
            completeness = new
            {
                question = "Q1",
                per_kind = perKind,
                value = completenessVal,
                status = status
            }
        };

        var jsonOpts = new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        Console.WriteLine(JsonSerializer.Serialize(output, jsonOpts));
        return 0;
    }

    private static string DetermineKind(string typeName, string relPath, TypeDeclarationSyntax? syntax)
    {
        if (typeName.EndsWith("Dto") || typeName.EndsWith("Request") || typeName.EndsWith("Response")) return "dto";
        if (typeName.EndsWith("Entity") || relPath.Contains("/Domain/") || relPath.Contains("/Entities/") || typeName == "Order") return "entity";
        if (typeName.EndsWith("Context") || typeName.EndsWith("Table")) return "table";
        if (typeName.EndsWith("Service") || typeName.EndsWith("Controller")) return "class";
        return "class";
    }

    private static string MakeNodeId(string project, string kind, string path, string nodeKey)
    {
        string normProject = (project ?? "").Trim();
        string normKind = (kind ?? "").Trim();
        string normPath = (path ?? "").Replace('\\', '/').Trim();
        string normKey = (nodeKey ?? "").Trim();

        string raw = $"{normProject}:{normKind}:{normPath}:{normKey}";
        using var sha256 = SHA256.Create();
        byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(raw));
        string hex = Convert.ToHexString(hashBytes).ToLowerInvariant().Substring(0, 16);
        return $"node_{hex}";
    }

    private static string MakeEdgeId(string fromNodeId, string toNodeId, string kind)
    {
        return $"edge_{fromNodeId}_{toNodeId}_{kind}";
    }

    private static void AddNode(List<NodeRecord> nodes, Dictionary<string, NodeRecord> map, Dictionary<string, string> keyToId, NodeRecord record)
    {
        if (!map.ContainsKey(record.node_id))
        {
            map[record.node_id] = record;
            keyToId[$"{record.kind}:{record.node_key}"] = record.node_id;
            nodes.Add(record);
        }
    }

    private static void AddEdgeWithClaim(
        List<EdgeRecord> edges,
        List<ClaimRecord> claims,
        string project,
        string buildId,
        string fromNodeId,
        string toNodeId,
        string kind,
        string claimText)
    {
        string edgeId = MakeEdgeId(fromNodeId, toNodeId, kind);
        if (!edges.Any(e => e.edge_id == edgeId))
        {
            edges.Add(new EdgeRecord
            {
                edge_id = edgeId,
                project = project,
                build_id = buildId,
                from_node_id = fromNodeId,
                to_node_id = toNodeId,
                kind = kind,
                conflict = false
            });

            claims.Add(new ClaimRecord
            {
                edge_id = edgeId,
                project = project,
                build_id = buildId,
                seq = 1,
                source_kind = "roslyn",
                claim = claimText
            });
        }
    }

    public class NodeRecord
    {
        public string node_id { get; set; } = "";
        public string project { get; set; } = "";
        public string build_id { get; set; } = "";
        public string kind { get; set; } = "";
        public string node_key { get; set; } = "";
        public string path { get; set; } = "";
    }

    public class EdgeRecord
    {
        public string edge_id { get; set; } = "";
        public string project { get; set; } = "";
        public string build_id { get; set; } = "";
        public string from_node_id { get; set; } = "";
        public string to_node_id { get; set; } = "";
        public string kind { get; set; } = "";
        public bool conflict { get; set; }
    }

    public class ClaimRecord
    {
        public string edge_id { get; set; } = "";
        public string project { get; set; } = "";
        public string build_id { get; set; } = "";
        public int seq { get; set; } = 1;
        public string source_kind { get; set; } = "roslyn";
        public string claim { get; set; } = "";
    }
}
