namespace SimpleMonolith.Services;

using SimpleMonolith.Domain;
using SimpleMonolith.Repositories;
using SimpleMonolith.Contracts;

public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public OrderDto CreateOrder(string customerName, decimal amount)
    {
        var order = new Order
        {
            CustomerName = customerName,
            TotalAmount = amount
        };
        _repository.Save(order);
        return new OrderDto
        {
            Id = order.Id,
            CustomerName = order.CustomerName
        };
    }
}
