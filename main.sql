select title, rental_duration from film where  rental_duration != 5;

select  * from customer  where lower(first_name) = 'mary';
select  * from rental where rental_date >= '2006-01-01';
select  * from rental where rental_date = '2006-02-14 15:16:03';

select title, length, rental_duration from film where length > 100 and rental_duration = 5;
select title, length, rental_duration from film where ( length > 100 or rental_duration = 5) or left (title ,1) = 'A';
select title, length, rental_duration from film where not rental_duration = 5;

select * from customer where email  is not null ;
select  title, rating from film where rating  != 'PG' or rating is null;

select  customer_id from customer where customer_id not  between  1 and 5;
select  customer_id from customer where customer_id not in(1,5,8);
select  first_name from customer where left(first_name, 1) in ('A', 'F', 'J');

select  first_name from customer where first_name  like 'M%';
select  first_name from customer where first_name  like '__M%';
select  first_name from customer where first_name ilike '__m%';

select  first_name from customer where first_name similar to  'M%L{2}%';

select title, length from film order by length desc, title asc;
select title, length from film order by right(title, 1), length desc;

/* execution order in SQL:
1. from
2. where
3. group by: aggrigate rows
4. having: filter the agregates
5. select
6. order by
7. limit
*/

-- Pagination
select first_name, last_name from customer order by first_name limit 5;
select first_name, last_name from customer order by first_name limit 5 offset 10;
-- Non standart pagination
select first_name, last_name from customer order by first_name offset 10 fetch next 5 rows only;

--Remove duplicate rows (Unique combination of columns)
select distinct customer_id from payment;
select distinct date_part('month', payment_date) as month, date_part('year', payment_date) as year from payment order by year, month;

--if statment
select title, length,
	case
		when length <= 60 then 'short'
		when length > 60 and length <=120 then 'long'
		when length > 120 then 'very long'
		else 'unknown'
	end as lenght_description
from film;

-- Aaggregate Funtions
select count(*) from film;
select count(distinct rating) from film;
select sum(length) from film;
select min(amount), max(amount), avg(amount) from payment;

-- GROUP BY and HAVING(filter the result)
select rating, count(*) from film group by rating;

select customer_id, staff_id, count(*) from payment
group by customer_id, staff_id 
having count(*) > 20
order by customer_id , staff_id;
-- Group by fist latter of user name
select left(first_name, 1) as first_latter, count(*) from customer
group by left(first_name, 1)
order by first_latter;