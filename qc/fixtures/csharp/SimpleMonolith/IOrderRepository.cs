namespace SimpleMonolith.Repositories;

using SimpleMonolith.Domain;

public interface IOrderRepository
{
    Order? GetById(int id);
    void Save(Order order);
}
