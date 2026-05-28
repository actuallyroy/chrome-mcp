// Single-STA dispatch worker. All Dispatcher.Dispatch calls funnel through
// here so COM / UIA work happens on one thread with STA apartment, regardless
// of which thread the transport (stdin reader, TCP accept loop) called from.
//
// Why: System.Windows.Automation is "MTA-tolerant" in name only —
// AutomationElement event subscriptions, certain pattern setters on
// WPF/Win32 hybrids, and FocusChangedEvent paths deadlock or silently no-op
// on MTA. Pinning to one STA thread is the safe pattern.

using System.Collections.Concurrent;

namespace WindowsMcpHelper;

internal static class UiaWorker
{
    private sealed class WorkItem
    {
        public required Func<object?> Job;
        public required TaskCompletionSource<object?> Tcs;
    }

    private static readonly BlockingCollection<WorkItem> _queue = new(new ConcurrentQueue<WorkItem>());
    private static Thread? _thread;

    public static void Start()
    {
        if (_thread != null) return;
        _thread = new Thread(WorkerLoop)
        {
            Name = "windows-mcp-uia-worker",
            IsBackground = true,
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    public static void Stop()
    {
        try { _queue.CompleteAdding(); } catch { }
    }

    public static Task<object?> RunAsync(Func<object?> job)
    {
        var tcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            _queue.Add(new WorkItem { Job = job, Tcs = tcs });
        }
        catch (InvalidOperationException)
        {
            tcs.TrySetException(new InvalidOperationException("uia worker has stopped"));
        }
        return tcs.Task;
    }

    private static void WorkerLoop()
    {
        foreach (var item in _queue.GetConsumingEnumerable())
        {
            try
            {
                var result = item.Job();
                item.Tcs.TrySetResult(result);
            }
            catch (Exception ex)
            {
                item.Tcs.TrySetException(ex);
            }
        }
    }
}
